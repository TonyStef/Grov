// Drift detection logic for anti-drift system
// Uses Claude Haiku 4.5 for LLM-based drift scoring
//
// CRITICAL: We check Claude's ACTIONS, NOT user prompts.
// User can explore freely. We monitor what CLAUDE DOES.

import Anthropic from '@anthropic-ai/sdk';
import { isAnthropicAvailable, getDriftModel } from './llm-extractor.js';
import type { SessionState, RecoveryPlan, StepRecord } from './store.js';
import { getRelevantSteps, getRecentSteps } from './store.js';
import type { ClaudeAction } from './session-parser.js';
import { extractFilesFromActions, extractFoldersFromActions } from './session-parser.js';
import { debugInject } from './debug.js';

// ============================================
// CONFIGURATION
// ============================================

export const DRIFT_CONFIG = {
  SCORE_NO_INJECTION: 8,     // >= 8: no correction
  SCORE_NUDGE: 7,            // 7: nudge
  SCORE_CORRECT: 5,          // 5-6: correct
  SCORE_INTERVENE: 3,        // 3-4: intervene
  SCORE_HALT: 1,             // 1-2: halt
  MAX_WARNINGS_BEFORE_FLAG: 3,
  AVG_SCORE_THRESHOLD: 6,
  MAX_ESCALATION: 3,
};

// ============================================
// INTERFACES
// ============================================

/**
 * Input for drift check
 *
 * CRITICAL: We check Claude's ACTIONS, not user prompts.
 * The user can ask whatever they want - we monitor what CLAUDE DOES.
 */
export interface DriftCheckInput {
  // Original intent from first prompt
  originalGoal: string;
  expectedScope: string[];
  constraints: string[];
  keywords: string[];
  // Session context
  driftHistory: Array<{ score: number; level: string }>;
  escalationCount: number;
  // Claude's ACTIONS (NOT user prompt!)
  claudeActions: ClaudeAction[];
  retrievedSteps: StepRecord[];  // From 4-query retrieval
  lastNSteps: StepRecord[];       // Recent steps for pattern detection
}

/**
 * Result from drift check
 */
export interface DriftCheckResult {
  score: number;                    // 1-10 alignment score
  type: 'aligned' | 'minor' | 'moderate' | 'severe' | 'critical';
  diagnostic: string;               // What's wrong
  recoveryPlan?: RecoveryPlan;      // Steps to get back on track
  boundaries: string[];             // What should NOT be done
  verification: string;             // How to confirm alignment
}

// ============================================
// MAIN FUNCTIONS
// ============================================

/**
 * Build input for drift check from Claude's ACTIONS and session state.
 *
 * CRITICAL: We check ACTIONS, not user prompts.
 */
export function buildDriftCheckInput(
  claudeActions: ClaudeAction[],
  sessionId: string,
  sessionState: SessionState
): DriftCheckInput {
  // Extract files/folders from current actions for retrieval
  const currentFiles = extractFilesFromActions(claudeActions);
  const currentFolders = extractFoldersFromActions(claudeActions);

  return {
    originalGoal: sessionState.original_goal || '',
    expectedScope: sessionState.expected_scope,
    constraints: sessionState.constraints,
    keywords: sessionState.keywords,
    driftHistory: (sessionState.drift_history || []).map(h => ({
      score: h.score,
      level: h.level
    })),
    escalationCount: sessionState.escalation_count,
    // Claude's ACTIONS
    claudeActions,
    // 4-query retrieval for context
    retrievedSteps: getRelevantSteps(sessionId, currentFiles, currentFolders, sessionState.keywords, 10),
    lastNSteps: getRecentSteps(sessionId, 5)
  };
}

/**
 * Check drift using LLM or fallback
 */
export async function checkDrift(input: DriftCheckInput): Promise<DriftCheckResult> {
  // Try LLM if available
  if (isAnthropicAvailable()) {
    try {
      return await checkDriftWithLLM(input);
    } catch (error) {
      debugInject('checkDrift LLM failed, using fallback: %O', error);
      return checkDriftBasic(input);
    }
  }

  // Fallback to basic detection
  return checkDriftBasic(input);
}

/**
 * LLM-based drift detection using Claude Haiku 4.5.
 *
 * CRITICAL: Analyzes Claude's ACTIONS, not user prompts.
 */
async function checkDriftWithLLM(input: DriftCheckInput): Promise<DriftCheckResult> {
  const anthropic = new Anthropic();
  const model = getDriftModel();

  // Format Claude's actions for the prompt
  const actionsText = input.claudeActions.length > 0
    ? input.claudeActions.map(a => {
        if (a.type === 'bash') return `- ${a.type}: ${a.command?.substring(0, 100) || 'no command'}`;
        return `- ${a.type}: ${a.files.join(', ') || 'no files'}`;
      }).join('\n')
    : 'No actions yet';

  // Format recent steps for context
  const recentStepsText = input.lastNSteps.length > 0
    ? input.lastNSteps.map(s => `- ${s.action_type}: ${s.files.slice(0, 2).join(', ')} (score: ${s.drift_score})`).join('\n')
    : 'No previous steps';

  const driftContext = input.driftHistory.length > 0
    ? `Previous drift events: ${input.driftHistory.map(h => `score=${h.score}`).join(', ')}`
    : 'No previous drift events';

  const response = await anthropic.messages.create({
    model,
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content: `You are a drift detection system. Analyze if Claude's ACTIONS align with the original goal.

IMPORTANT: We monitor Claude's ACTIONS, not user prompts. Users can ask anything - we check what Claude DOES.

ORIGINAL GOAL:
${input.originalGoal}

EXPECTED SCOPE (files/components Claude should touch):
${input.expectedScope.length > 0 ? input.expectedScope.join(', ') : 'Not specified'}

CONSTRAINTS:
${input.constraints.length > 0 ? input.constraints.join(', ') : 'None specified'}

KEY TERMS:
${input.keywords.join(', ')}

${driftContext}
Current escalation level: ${input.escalationCount}

CLAUDE'S RECENT ACTIONS:
${actionsText}

PREVIOUS STEPS IN SESSION:
${recentStepsText}

CHECK FOR:
1. Files OUTSIDE expected scope (editing unrelated files)
2. Repetition patterns (same file edited 3+ times without progress)
3. Tangential work (styling when goal is auth)
4. New features not requested
5. "While I'm here" patterns (scope creep)

LEGITIMATE (NOT drift):
- Editing utility files imported by main files
- Fixing bugs discovered while working
- Updating tests for modified code
- Reading ANY file (exploration is OK)

Rate 1-10:
- 10: Actions directly advance the goal
- 8-9: Minor deviation but related (e.g., helper file)
- 5-7: Moderate drift, tangentially related
- 3-4: Significant drift, unrelated files
- 1-2: Critical drift, completely off-track

Return ONLY valid JSON:
{
  "score": <1-10>,
  "type": "aligned|minor|moderate|severe|critical",
  "diagnostic": "Brief explanation of drift based on ACTIONS (1 sentence)",
  "recovery_steps": [{"file": "optional/path", "action": "what to do"}],
  "boundaries": ["Things that should NOT be done"],
  "verification": "How to confirm we're back on track"
}

Return ONLY valid JSON.`
      }
    ]
  });

  // Extract text content
  const content = response.content[0];
  if (content.type !== 'text') {
    throw new Error('Unexpected response type');
  }

  // Strip markdown code blocks if present
  let jsonText = content.text.trim();
  if (jsonText.startsWith('```')) {
    jsonText = jsonText.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }

  debugInject('LLM raw response: %s', jsonText.substring(0, 200));

  const parsed = JSON.parse(jsonText) as {
    score?: number | string;
    type?: string;
    diagnostic?: string;
    recovery_steps?: Array<{ file?: string; action: string }>;
    boundaries?: string[];
    verification?: string;
  };

  // Handle score as string or number
  const rawScore = typeof parsed.score === 'string' ? parseInt(parsed.score, 10) : parsed.score;
  const score = Math.min(10, Math.max(1, rawScore || 5));

  debugInject('LLM parsed score: raw=%s, final=%d', parsed.score, score);

  return {
    score,
    type: mapScoreToType(score),
    diagnostic: parsed.diagnostic || 'Unable to determine drift status',
    recoveryPlan: parsed.recovery_steps ? { steps: parsed.recovery_steps } : undefined,
    boundaries: parsed.boundaries || [],
    verification: parsed.verification || 'Complete the original task'
  };
}

/**
 * Basic drift detection without LLM.
 *
 * CRITICAL: Checks Claude's ACTIONS, not user prompts.
 * - Read actions are ALWAYS OK (exploration is not drift)
 * - Edit/Write actions outside scope = drift
 * - Repetition patterns = drift
 */
export function checkDriftBasic(input: DriftCheckInput): DriftCheckResult {
  const issues: string[] = [];

  // Filter to modifying actions only (read is always OK)
  const modifyingActions = input.claudeActions.filter(
    a => a.type !== 'read' && a.type !== 'grep' && a.type !== 'glob'
  );

  // No modifying actions = no drift possible
  if (modifyingActions.length === 0) {
    return {
      score: 10,
      type: 'aligned',
      diagnostic: 'No modifying actions - exploration only',
      boundaries: [],
      verification: `Continue with: ${input.originalGoal.substring(0, 50)}`
    };
  }

  // Count files in-scope vs out-of-scope
  let inScopeCount = 0;
  let outOfScopeCount = 0;
  const allFiles: string[] = [];

  for (const action of modifyingActions) {
    for (const file of action.files) {
      if (!file) continue;
      allFiles.push(file);

      // If no scope defined, assume all files are OK
      if (input.expectedScope.length === 0) {
        inScopeCount++;
        continue;
      }

      // Check if file is in scope
      const inScope = input.expectedScope.some(scope => {
        // file contains scope pattern (e.g., "src/auth/token.ts" contains "src/auth/")
        if (file.includes(scope)) return true;
        // scope contains the file name (e.g., "src/lib/token.ts" contains "token.ts")
        const fileName = file.split('/').pop() || '';
        if (scope.includes(fileName) && fileName.length > 0) return true;
        return false;
      });

      if (inScope) {
        inScopeCount++;
      } else {
        outOfScopeCount++;
        issues.push(`File outside scope: ${file.split('/').pop()}`);
      }
    }
  }

  // Calculate score based on in-scope ratio
  let score: number;
  const totalFiles = inScopeCount + outOfScopeCount;

  if (totalFiles === 0) {
    score = 10;
  } else if (outOfScopeCount === 0) {
    // All files in scope = perfect
    score = 10;
  } else if (inScopeCount === 0) {
    // All files out of scope = critical drift
    score = Math.max(1, 4 - outOfScopeCount); // 1-4 depending on how many
  } else {
    // Mixed: some in, some out
    const ratio = inScopeCount / totalFiles;
    // ratio 1.0 = 10, ratio 0.5 = 6, ratio 0.0 = 2
    score = Math.round(2 + ratio * 8);
    // Additional penalty for each out-of-scope file
    score = Math.max(1, score - outOfScopeCount);
  }

  // Check for repetition patterns (same file edited 3+ times)
  // Use unique files to avoid double-counting
  const recentFiles = input.lastNSteps.flatMap(s => s.files);
  const uniqueCurrentFiles = [...new Set(allFiles)];

  for (const file of uniqueCurrentFiles) {
    const timesEdited = recentFiles.filter(f => f === file).length;
    if (timesEdited >= 3) {
      score = Math.max(1, score - 2);
      issues.push(`Repetition: ${file.split('/').pop()} edited ${timesEdited}+ times`);
    }
  }

  // Clamp score
  score = Math.max(1, Math.min(10, score));

  // Determine diagnostic
  let diagnostic: string;
  if (score >= 8) {
    diagnostic = 'Actions align with original goal';
  } else if (score >= 5) {
    diagnostic = issues.length > 0 ? issues[0] : 'Actions partially relate to goal';
  } else if (score >= 3) {
    diagnostic = issues.length > 0 ? issues.join('; ') : 'Actions deviate from goal';
  } else {
    diagnostic = issues.length > 0 ? issues.join('; ') : 'Actions do not relate to original goal';
  }

  return {
    score,
    type: mapScoreToType(score),
    diagnostic,
    recoveryPlan: score < 5 ? { steps: [{ action: `Return to: ${input.originalGoal.substring(0, 50)}` }] } : undefined,
    boundaries: [],
    verification: `Continue with: ${input.originalGoal.substring(0, 50)}`
  };
}

/**
 * Infer action type from prompt
 */
export function inferAction(prompt: string): string {
  const lower = prompt.toLowerCase();

  if (lower.includes('fix') || lower.includes('bug') || lower.includes('error')) {
    return 'fix';
  }
  if (lower.includes('add') || lower.includes('create') || lower.includes('implement')) {
    return 'add';
  }
  if (lower.includes('refactor') || lower.includes('improve') || lower.includes('clean')) {
    return 'refactor';
  }
  if (lower.includes('test') || lower.includes('spec')) {
    return 'test';
  }
  if (lower.includes('doc') || lower.includes('comment') || lower.includes('readme')) {
    return 'document';
  }
  if (lower.includes('update') || lower.includes('change') || lower.includes('modify')) {
    return 'update';
  }
  if (lower.includes('remove') || lower.includes('delete')) {
    return 'remove';
  }

  return 'unknown';
}

// ============================================
// HELPERS
// ============================================

/**
 * Map numeric score to drift type
 */
function mapScoreToType(score: number): DriftCheckResult['type'] {
  if (score >= 8) return 'aligned';
  if (score >= 6) return 'minor';
  if (score >= 4) return 'moderate';
  if (score >= 2) return 'severe';
  return 'critical';
}
