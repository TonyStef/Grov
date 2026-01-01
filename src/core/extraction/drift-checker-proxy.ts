// Drift checker for proxy - scores Claude's actions vs original goal
// Reference: plan_proxy_local.md Section 4.2, 4.3

import type { SessionState, StepRecord, DriftType, CorrectionLevel } from '../store/store.js';
import { forwardToAnthropic } from '../../integrations/proxy/agents/claude/forwarder.js';
import { buildSafeHeaders } from '../../integrations/proxy/config.js';
import type { RequestHeaders } from './llm-extractor.js';
import { isDebugMode } from '../../integrations/proxy/utils/logging.js';

export interface DriftCheckInput {
  sessionState: SessionState;
  recentSteps: StepRecord[];
  latestUserMessage?: string;  // Current user instruction (takes priority over original_goal)
}

export interface DriftCheckResult {
  score: number;
  driftType: DriftType;
  diagnostic: string;
  suggestedAction?: string;
  recoverySteps?: string[];
}

// Haiku model constant
// Model list: https://docs.anthropic.com/en/docs/about-claude/models
const HAIKU_MODEL = 'claude-haiku-4-5-20251001';

async function callHaikuDrift(
  maxTokens: number,
  prompt: string,
  headers: RequestHeaders,
  context: string = 'unknown'
): Promise<{ text: string; success: boolean }> {
  if (isDebugMode()) console.log(`[HAIKU] ${context} started`);

  // Use same header filtering as proxy forward - includes all Claude Code headers
  const safeHeaders = buildSafeHeaders(headers);

  try {
    const result = await forwardToAnthropic(
      {
        model: HAIKU_MODEL,
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }],
      },
      safeHeaders
    );

    // Check for error response
    if (result.statusCode >= 400) {
      const errorBody = result.body as { error?: { message?: string } };
      throw new Error(errorBody.error?.message || `HTTP ${result.statusCode}`);
    }

    // Parse response
    const body = result.body as { content?: Array<{ type: string; text?: string }> };
    const text = body.content?.[0]?.type === 'text' ? body.content[0].text || '' : '';

    if (isDebugMode()) console.log(`[HAIKU] ${context} success`);
    return { text, success: true };
  } catch (err) {
    // Always log errors
    console.error(`[HAIKU] ${context} error:`, (err as Error).message);
    return { text: '', success: false };
  }
}

/**
 * Main drift check - uses LLM with auth
 */
export async function checkDrift(input: DriftCheckInput, headers: RequestHeaders): Promise<DriftCheckResult> {
  try {
    return await checkDriftWithLLM(input, headers);
  } catch {
    // Fallback to basic if LLM fails
    return checkDriftBasic(input);
  }
}

/**
 * Build repetition context for files edited 5+ times
 */
function buildRepetitionContext(steps: StepRecord[]): string {
  const fileCounts = new Map<string, number>();
  for (const step of steps) {
    if (step.action_type === 'edit' || step.action_type === 'write') {
      for (const file of step.files) {
        fileCounts.set(file, (fileCounts.get(file) || 0) + 1);
      }
    }
  }

  const repeated = [...fileCounts.entries()]
    .filter(([, count]) => count >= 5)
    .map(([file, count]) => `${file} (${count}x)`);

  return repeated.length > 0 ? repeated.join(', ') : '';
}

/**
 * LLM-based drift check using Haiku
 * Reference: plan_proxy_local.md Section 3.1
 */
async function checkDriftWithLLM(input: DriftCheckInput, headers: RequestHeaders): Promise<DriftCheckResult> {
  // WHITELIST only modification actions for drift evaluation
  // Reading/exploring is ALWAYS OK - we only care about actual changes
  //
  // Modification actions (INCLUDE in drift check):
  //   - edit: file modifications
  //   - write: new files created
  //   - bash: commands that might modify state
  //
  // Read-like actions (EXCLUDE from drift check):
  //   - read: Read tool, cat, head, tail, less, more, type (Windows)
  //   - glob: Glob tool, find, ls, dir (Windows)
  //   - grep: Grep tool, rg, ack, findstr (Windows)
  //   - task: Subagent (usually research/exploration)
  //   - other: Various non-modification tools
  //
  // Note: bash could be read-like (cat) or modify-like (rm, npm install).
  // We include bash because modifications through it are significant.
  const modificationActions = new Set(['edit', 'write', 'bash']);
  const modificationSteps = input.recentSteps
    .slice(-10)
    .filter(step => modificationActions.has(step.action_type));

  const actionsText = modificationSteps
    .map(step => {
      if (step.action_type === 'bash' && step.command) {
        return `- ${step.action_type}: ${step.command.substring(0, 100)}`;
      }
      if (step.files.length > 0) {
        return `- ${step.action_type}: ${step.files.join(', ')}`;
      }
      return `- ${step.action_type}`;
    })
    .join('\n');

  // If we have a latest user message, that's the CURRENT instruction
  // Use 1500 chars to avoid cutting off complex instructions mid-thought
  const currentInstruction = input.latestUserMessage?.substring(0, 1500) || '';
  const hasCurrentInstruction = currentInstruction.length > 20;
  const repetitionContext = buildRepetitionContext(input.recentSteps);

  const prompt = `<purpose>
You are a LENIENT drift detection system for a coding assistant.
Your job: Check if Claude is following the user's instructions.

CRITICAL MINDSET:
- Default assumption: Claude is doing fine (score 8)
- Only lower score when you see CLEAR, OBVIOUS problems
- Scores 5-10 are all acceptable - no action needed for these scores
</purpose>

<context>
<current_instruction priority="PRIMARY" weight="90%">
This is what the user JUST asked for. Compare actions against THIS.
"${hasCurrentInstruction ? currentInstruction : 'Not specified'}"
</current_instruction>

<original_goal priority="SECONDARY" weight="10%">
This was the initial goal. User may have changed direction - that's OK.
"${input.sessionState.original_goal || 'Not specified'}"
</original_goal>

<constraints>
${input.sessionState.constraints.length > 0 ? input.sessionState.constraints.join(', ') : 'None'}
</constraints>

<recent_actions context_only="true">
These are Claude's recent actions. Use for understanding, NOT for automatic penalties.
${actionsText || 'No actions yet'}
</recent_actions>
${repetitionContext ? `
<repetition_notice>
Files edited 5+ times: ${repetitionContext}

This is NOT automatically bad. Check:
- Is Claude making incremental progress?
- Or is Claude stuck repeating the exact same fix?
</repetition_notice>
` : ''}
</context>

<scoring_guide>
<score_9_10 meaning="ON TRACK - Excellent">
Claude is doing EXACTLY what user asked, or very close.

GIVE 9-10 WHEN:
- Actions directly match current_instruction
- New files created that user requested (even if not explicitly named)
- Working on files related to the task
- Making clear progress toward goal

EXAMPLES:
- User: "add login feature" → Claude creates src/auth/login.ts → Score: 10
- User: "fix the bug in payments" → Claude edits src/payments/checkout.ts → Score: 10
- User: "research how X works" → Claude creates docs/research-X.md → Score: 10
- User: "refactor the API" → Claude edits multiple API files → Score: 9
</score_9_10>

<score_5_8 meaning="ACCEPTABLE - Fine, no issues">
Claude is doing related work, not perfect but acceptable.

GIVE 5-8 WHEN:
- Actions are RELATED to the task but not exact match
- Claude is exploring/investigating before implementing
- Some actions seem tangential but could be necessary

EXAMPLES:
- User: "fix auth bug" → Claude reads config files first → Score: 8 (investigating)
- User: "add feature X" → Claude refactors nearby code first → Score: 7 (prep work)
- User: "update the UI" → Claude also updates related tests → Score: 8 (good practice)
</score_5_8>

<score_4 meaning="MILD CONCERN - Yellow flag">
Something seems off but not critically wrong.

GIVE 4 WHEN:
- Actions feel disconnected from instruction
- Claude might be going in circles
- Possible misunderstanding of task

EXAMPLES:
- User: "fix login" → Claude spends time on logout → Score: 4 (related but not asked)
- Claude edits same file 5+ times with SAME reasoning repeated → Score: 4
- User: "quick fix" → Claude starts major refactor → Score: 4 (scope mismatch)
</score_4>

<score_1_3 meaning="REAL DRIFT - Red flag">
Claude is clearly doing something WRONG or STUCK.

GIVE 1-3 ONLY WHEN:
- Actions are COMPLETELY unrelated to instruction
- Claude explicitly violates user's constraints
- Clear evidence of being stuck in loop (same error, same fix, no progress)
- Doing the OPPOSITE of what user asked

EXAMPLES:
- User: "fix auth bug" → Claude refactors CSS styling → Score: 2 (completely unrelated)
- User: "don't modify config" → Claude modifies config → Score: 1 (violated constraint)
- User: "just analyze, don't change" → Claude rewrites code → Score: 2 (opposite)
- User: "work on backend" → Claude only touches frontend → Score: 2 (wrong area)
</score_1_3>
</scoring_guide>

<detailed_rules>
<rule name="NEW_FILES">
WHEN IT'S OK (score 9-10):
- User asked for something that requires new files
- File is in a logical location for the task

WHEN IT'S BAD (score 1-4):
- File has nothing to do with current instruction
- User explicitly said "don't create new files"

EXAMPLES:
- User: "create a plan" → Claude creates docs/plan.md → Score: 10
- User: "fix typo in README" → Claude creates src/new-module.ts → Score: 2
</rule>

<rule name="MULTIPLE_EDITS">
WHEN IT'S OK (score 8-10):
- Each edit has DIFFERENT purpose
- Claude is iterating: add feature → add tests → fix edge case

WHEN IT'S BAD (score 3-4):
- ALL edits have SAME reasoning: "fixing error" → "fixing error" → "fixing error"
- No progress visible between edits

EXAMPLES:
- Edit 1: "added login" → Edit 2: "added validation" → Edit 3: "added tests" → Score: 9
- Edit 1: "fix bug" → Edit 2: "fix bug" → Edit 3: "fix bug" → Edit 4: "fix bug" → Score: 3
</rule>

<rule name="WRONG_DIRECTION">
HOW TO IDENTIFY:
- Ask: "Does this action help achieve current_instruction?"
- If answer is "no" or "I can't see how" → wrong direction (score 1-3)
- If answer is "maybe" or "indirectly" → probably OK (score 6-8)

EXAMPLES OF WRONG DIRECTION:
- User wants backend fix → Claude only touches CSS (score 2)
- User wants bug fix → Claude adds new features instead (score 3)
- User wants analysis → Claude starts rewriting without being asked (score 2)

NOT WRONG DIRECTION:
- User wants feature A → Claude reads related code first (score 9)
- User wants fix X → Claude also updates tests for X (score 9)
</rule>

<rule name="USER_CHANGED_DIRECTION">
If current_instruction differs from original_goal:
- ALWAYS prioritize current_instruction (90% weight)
- If Claude follows current_instruction but not original_goal → Score 9-10

EXAMPLE:
- Original goal: "analyze the codebase"
- Current instruction: "now create the implementation"
- Claude creates files → Score: 10 (following CURRENT instruction)
</rule>
</detailed_rules>

<anti_bias_rules>
DO NOT:
- Default to middle scores (5-7) without specific reason
- Penalize for new files automatically
- Penalize for multiple edits automatically

DO:
- Start with assumption of score 8
- Only lower if you find SPECIFIC evidence
- Give 9-10 generously when Claude is on track
</anti_bias_rules>

<response_format>
Return ONLY valid JSON:
{
  "score": <number 1-10>,
  "diagnostic": "<1-2 sentences explaining the score>",
  "evidence": "<specific action or pattern that led to this score>"
}
</response_format>`;

  const haikuResult = await callHaikuDrift(300, prompt, headers, 'checkDrift');
  if (!haikuResult.success) {
    return createDefaultResult(8, 'Haiku call failed');
  }

  return parseLLMResponse(haikuResult.text);
}

/**
 * Basic drift check without LLM (fallback)
 * Returns safe default - no penalties without LLM analysis
 */
export function checkDriftBasic(_input: DriftCheckInput): DriftCheckResult {
  // Without LLM, we can't make intelligent decisions
  // Return safe default to avoid false positives
  return {
    score: 8,
    driftType: 'none',
    diagnostic: 'Basic check - assuming on track (LLM not available)',
  };
}

/**
 * Parse LLM response JSON
 */
function parseLLMResponse(text: string): DriftCheckResult {
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return createDefaultResult(8, 'No JSON in response');
    }

    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
    const score = typeof parsed.score === 'number'
      ? Math.min(10, Math.max(1, parsed.score))
      : 8;

    return {
      score,
      driftType: scoreToDriftType(score),
      diagnostic: typeof parsed.diagnostic === 'string' ? parsed.diagnostic : 'Unknown',
      suggestedAction: typeof parsed.suggestedAction === 'string' ? parsed.suggestedAction : undefined,
      recoverySteps: Array.isArray(parsed.recoverySteps)
        ? parsed.recoverySteps.filter((s): s is string => typeof s === 'string')
        : undefined,
    };
  } catch {
    return createDefaultResult(8, 'Failed to parse response');
  }
}

/**
 * Convert score to drift type
 */
function scoreToDriftType(score: number): DriftType {
  if (score >= 8) return 'none';
  if (score >= 5) return 'minor';
  if (score >= 3) return 'major';
  return 'critical';
}

/**
 * Convert score to correction level
 * Reference: plan_proxy_local.md Section 4.3
 *
 * Thresholds (lenient):
 * - 5-10: OK, no correction needed
 * - 4: nudge (mild reminder)
 * - 3: correct (full correction)
 * - 1-2: intervene (strong intervention)
 */
export function scoreToCorrectionLevel(score: number): CorrectionLevel | null {
  if (score >= 5) return null;      // 5-10 = OK
  if (score === 4) return 'nudge';  // mild reminder
  if (score === 3) return 'correct'; // full correction
  return 'intervene';                // 1-2 = strong intervention
}

/**
 * Check if score requires skipping steps table
 * Reference: plan_proxy_local.md Section 4.2
 */
export function shouldSkipSteps(score: number): boolean {
  return score < 5;
}

/**
 * Create default result
 */
function createDefaultResult(score: number, diagnostic: string): DriftCheckResult {
  return {
    score,
    driftType: scoreToDriftType(score),
    diagnostic,
  };
}

// ============================================
// RECOVERY ALIGNMENT CHECK
// Reference: plan_proxy_local.md Section 4.4
// ============================================

/**
 * Check if Claude's action aligns with the recovery plan
 * Returns true if aligned, false if still drifting
 */
export function checkRecoveryAlignment(
  proposedAction: { actionType: string; files: string[]; command?: string },
  recoveryPlan: { steps: string[] } | undefined,
  sessionState: SessionState
): { aligned: boolean; reason: string } {
  if (!recoveryPlan || recoveryPlan.steps.length === 0) {
    // No recovery plan - allow action (scope checking removed)
    return { aligned: true, reason: 'No recovery plan defined' };
  }

  const firstStep = recoveryPlan.steps[0].toLowerCase();
  const actionDesc = `${proposedAction.actionType} ${proposedAction.files.join(' ')}`.toLowerCase();

  // Check for keyword matches
  const keywords = firstStep.split(/\s+/).filter(w => w.length > 3);
  const matches = keywords.filter(kw => actionDesc.includes(kw) || proposedAction.files.some(f => f.toLowerCase().includes(kw)));

  if (matches.length >= 2 || (matches.length >= 1 && proposedAction.files.length > 0)) {
    return { aligned: true, reason: `Action matches recovery step: ${firstStep}` };
  }

  return { aligned: false, reason: `Expected: ${firstStep}, Got: ${actionDesc}` };
}

// ============================================
// FORCED MODE - Haiku generates recovery prompt
// Reference: plan_proxy_local.md Section 4.4
// ============================================

export interface ForcedRecoveryResult {
  recoveryPrompt: string;
  mandatoryAction: string;
  injectionText: string;
}

/**
 * Generate forced recovery prompt using Haiku
 * Called when escalation_count >= 3 (forced mode)
 * This STOPS Claude and injects a specific recovery message
 */
export async function generateForcedRecovery(
  sessionState: SessionState,
  recentActions: Array<{ actionType: string; files: string[] }>,
  lastDriftResult: DriftCheckResult,
  headers: RequestHeaders
): Promise<ForcedRecoveryResult> {
  const actionsText = recentActions
    .slice(-5)
    .map(a => `- ${a.actionType}: ${a.files.join(', ')}`)
    .join('\n');

  const prompt = `You are helping recover a coding assistant that has COMPLETELY DRIFTED from its goal.

ORIGINAL GOAL: ${sessionState.original_goal || 'Not specified'}

CONSTRAINTS: ${sessionState.constraints.join(', ') || 'None'}

RECENT ACTIONS (all off-track):
${actionsText || 'None recorded'}

DRIFT DIAGNOSTIC: ${lastDriftResult.diagnostic}

ESCALATION COUNT: ${sessionState.escalation_count} (MAX REACHED)

Generate a STRICT recovery message that will:
1. STOP the assistant immediately
2. FORCE it to acknowledge the drift
3. Give ONE SPECIFIC, SIMPLE action to get back on track

RESPONSE RULES:
- English only
- No emojis
- Return JSON:
{
  "recoveryPrompt": "The full message to inject (be firm but constructive, ~200 words)",
  "mandatoryAction": "ONE specific action (e.g., 'Read src/auth/login.ts to refocus on authentication')"
}`;

  const haikuResult = await callHaikuDrift(600, prompt, headers, 'generateForcedRecovery');
  if (!haikuResult.success) {
    return createFallbackForcedRecovery(sessionState);
  }

  try {
    const jsonMatch = haikuResult.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return createFallbackForcedRecovery(sessionState);
    }

    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
    const recoveryPrompt = typeof parsed.recoveryPrompt === 'string'
      ? parsed.recoveryPrompt
      : `STOP. Return to: ${sessionState.original_goal}`;
    const mandatoryAction = typeof parsed.mandatoryAction === 'string'
      ? parsed.mandatoryAction
      : `Focus on ${sessionState.original_goal}`;

    return {
      recoveryPrompt,
      mandatoryAction,
      injectionText: formatForcedRecoveryInjection(recoveryPrompt, mandatoryAction, sessionState),
    };
  } catch {
    return createFallbackForcedRecovery(sessionState);
  }
}

/**
 * Format forced recovery for system prompt injection
 */
function formatForcedRecoveryInjection(
  recoveryPrompt: string,
  mandatoryAction: string,
  sessionState: SessionState
): string {
  return `

<grov_forced_recovery>
════════════════════════════════════════════════════════════
*** CRITICAL: FORCED RECOVERY MODE ACTIVATED ***
════════════════════════════════════════════════════════════

${recoveryPrompt}

────────────────────────────────────────────────────────────
MANDATORY FIRST ACTION (you MUST do this before ANYTHING else):
${mandatoryAction}
────────────────────────────────────────────────────────────

Original goal: ${sessionState.original_goal || 'See above'}
Escalation level: ${sessionState.escalation_count}/3 (MAXIMUM)

YOUR NEXT MESSAGE MUST:
1. Acknowledge: "I understand I have drifted from the goal"
2. State: "I will now ${mandatoryAction}"
3. Execute ONLY that action

ANY OTHER RESPONSE WILL BE REJECTED.
════════════════════════════════════════════════════════════
</grov_forced_recovery>

`;
}

/**
 * Fallback forced recovery without LLM
 */
function createFallbackForcedRecovery(sessionState: SessionState): ForcedRecoveryResult {
  const goal = sessionState.original_goal || 'the original task';
  const mandatoryAction = `Stop current work and return to: ${goal}`;

  return {
    recoveryPrompt: `You have completely drifted from your goal. Stop what you're doing immediately and refocus on: ${goal}`,
    mandatoryAction,
    injectionText: formatForcedRecoveryInjection(
      `You have completely drifted from your goal. Stop what you're doing immediately and refocus on: ${goal}`,
      mandatoryAction,
      sessionState
    ),
  };
}
