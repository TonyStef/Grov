// Drift checker for proxy - scores Claude's actions vs original goal
// Reference: plan_proxy_local.md Section 4.2, 4.3

import Anthropic from '@anthropic-ai/sdk';
import type { SessionState, StepRecord, DriftType, CorrectionLevel } from './store.js';

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

let anthropicClient: Anthropic | null = null;

function getAnthropicClient(): Anthropic {
  if (!anthropicClient) {
    const apiKey = process.env.ANTHROPIC_API_KEY || process.env.GROV_API_KEY;
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY or GROV_API_KEY required for drift checking');
    }
    anthropicClient = new Anthropic({ apiKey });
  }
  return anthropicClient;
}

/**
 * Check if drift checking is available
 */
export function isDriftCheckAvailable(): boolean {
  return !!(process.env.ANTHROPIC_API_KEY || process.env.GROV_API_KEY);
}

/**
 * Main drift check - uses LLM if available, fallback to basic
 */
export async function checkDrift(input: DriftCheckInput): Promise<DriftCheckResult> {
  if (isDriftCheckAvailable()) {
    try {
      return await checkDriftWithLLM(input);
    } catch (error) {
      console.error('LLM drift check failed, using basic:', error);
      return checkDriftBasic(input);
    }
  }
  return checkDriftBasic(input);
}

/**
 * LLM-based drift check using Haiku
 * Reference: plan_proxy_local.md Section 3.1
 */
async function checkDriftWithLLM(input: DriftCheckInput): Promise<DriftCheckResult> {
  const client = getAnthropicClient();

  const actionsText = input.recentSteps
    .slice(-10)
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
  const currentInstruction = input.latestUserMessage?.substring(0, 500) || '';
  const hasCurrentInstruction = currentInstruction.length > 20;

  const prompt = `You are a drift detection system. Check if Claude is following the user's CURRENT instructions.

${hasCurrentInstruction ? `CURRENT USER INSTRUCTION (PRIMARY - check against this!):
"${currentInstruction}"

ORIGINAL SESSION GOAL (secondary context):
${input.sessionState.original_goal || 'Not specified'}` : `ORIGINAL GOAL:
${input.sessionState.original_goal || 'Not specified'}`}

EXPECTED SCOPE: ${input.sessionState.expected_scope.length > 0 ? input.sessionState.expected_scope.join(', ') : 'Not specified'}

CONSTRAINTS FROM USER: ${input.sessionState.constraints.length > 0 ? input.sessionState.constraints.join(', ') : 'None'}

CLAUDE'S RECENT ACTIONS:
${actionsText || 'No actions yet'}

═══════════════════════════════════════════════════════════════
CRITICAL: Compare Claude's actions against ${hasCurrentInstruction ? 'CURRENT USER INSTRUCTION' : 'ORIGINAL GOAL'}
═══════════════════════════════════════════════════════════════

DRIFT = Claude doing something the user did NOT ask for, or IGNORING what user said.
NOT DRIFT = Claude following user's instructions, even if different from original goal.

Example:
- Original goal: "analyze the code"
- Current instruction: "now create the files"
- Claude creates files → NOT DRIFT (following current instruction)

CHECK FOR REAL DRIFT:
1. Claude modifying files user said NOT to modify
2. Claude ignoring explicit constraints ("don't run commands" but runs commands)
3. Claude doing unrelated work (user asks about auth, Claude fixes CSS)
4. Repetitive loops (editing same file 5+ times without progress)

Rate 1-10:
- 10: Perfect - following current instruction exactly
- 8-9: Good - on track with minor deviations
- 6-7: Moderate drift - needs nudge
- 4-5: Significant drift - ignoring parts of instruction
- 2-3: Major drift - doing opposite of what user asked
- 1: Critical - completely off track

RESPONSE RULES:
- English only
- No emojis
- Return JSON: {"score": N, "diagnostic": "brief reason", "suggestedAction": "what to do"}`;

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 300,
    messages: [{ role: 'user', content: prompt }],
  });

  const content = response.content?.[0];
  if (!content || content.type !== 'text') {
    return createDefaultResult(8, 'Could not parse LLM response');
  }

  return parseLLMResponse(content.text);
}

/**
 * Basic drift check without LLM (fallback)
 */
export function checkDriftBasic(input: DriftCheckInput): DriftCheckResult {
  let score = 8;
  const diagnostics: string[] = [];

  const { sessionState, recentSteps } = input;
  const expectedScope = sessionState.expected_scope;

  // Check if actions touch files outside scope
  for (const step of recentSteps) {
    if (step.action_type === 'read') continue; // Read is OK

    for (const file of step.files) {
      if (expectedScope.length > 0) {
        const inScope = expectedScope.some(scope => file.includes(scope));
        if (!inScope) {
          score -= 2;
          diagnostics.push(`File outside scope: ${file}`);
        }
      }
    }
  }

  // Check repetition (same file edited 3+ times recently)
  const fileCounts = new Map<string, number>();
  for (const step of recentSteps) {
    if (step.action_type === 'edit' || step.action_type === 'write') {
      for (const file of step.files) {
        fileCounts.set(file, (fileCounts.get(file) || 0) + 1);
      }
    }
  }
  for (const [file, count] of fileCounts) {
    if (count >= 3) {
      score -= 1;
      diagnostics.push(`Repeated edits to ${file} (${count}x)`);
    }
  }

  score = Math.max(1, Math.min(10, score));

  return {
    score,
    driftType: scoreToDriftType(score),
    diagnostic: diagnostics.length > 0 ? diagnostics.join('; ') : 'On track',
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
 */
export function scoreToCorrectionLevel(score: number): CorrectionLevel | null {
  if (score >= 8) return null;
  if (score === 7) return 'nudge';
  if (score >= 5) return 'correct';
  if (score >= 3) return 'intervene';
  return 'halt';
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
    // No recovery plan - check if action is within scope
    if (sessionState.expected_scope.length === 0) {
      return { aligned: true, reason: 'No recovery plan or scope defined' };
    }

    // Check if files are in expected scope
    const inScope = proposedAction.files.every(file =>
      sessionState.expected_scope.some(scope => file.includes(scope))
    );

    return {
      aligned: inScope,
      reason: inScope ? 'Files within expected scope' : 'Files outside expected scope',
    };
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
  lastDriftResult: DriftCheckResult
): Promise<ForcedRecoveryResult> {
  const client = getAnthropicClient();

  const actionsText = recentActions
    .slice(-5)
    .map(a => `- ${a.actionType}: ${a.files.join(', ')}`)
    .join('\n');

  const prompt = `You are helping recover a coding assistant that has COMPLETELY DRIFTED from its goal.

ORIGINAL GOAL: ${sessionState.original_goal || 'Not specified'}

EXPECTED SCOPE: ${sessionState.expected_scope.join(', ') || 'Not specified'}

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

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 600,
    messages: [{ role: 'user', content: prompt }],
  });

  const content = response.content?.[0];
  if (!content || content.type !== 'text') {
    return createFallbackForcedRecovery(sessionState);
  }

  try {
    const jsonMatch = content.text.match(/\{[\s\S]*\}/);
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
⚠️  CRITICAL: FORCED RECOVERY MODE ACTIVATED  ⚠️
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
