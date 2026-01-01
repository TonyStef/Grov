// Correction builder for proxy - creates messages to inject when drift detected
// Reference: plan_proxy_local.md Section 4.3, 4.4

import type { SessionState, CorrectionLevel } from '../store/store.js';
import type { DriftCheckResult } from './drift-checker-proxy.js';

export interface CorrectionMessage {
  level: CorrectionLevel;
  message: string;
  mandatoryAction?: string;
}

/**
 * Build correction message based on drift result and session state
 * Reference: plan_proxy_local.md Section 4.3
 */
export function buildCorrection(
  result: DriftCheckResult,
  sessionState: SessionState,
  level: CorrectionLevel
): CorrectionMessage {
  switch (level) {
    case 'nudge':
      return buildNudge(result, sessionState);
    case 'correct':
      return buildCorrect(result, sessionState);
    case 'intervene':
      return buildIntervene(result, sessionState);
    case 'halt':
      return buildHalt(result, sessionState);
  }
}

/**
 * NUDGE: Brief reminder (score 7)
 */
function buildNudge(result: DriftCheckResult, sessionState: SessionState): CorrectionMessage {
  const goal = sessionState.original_goal || 'the original task';

  return {
    level: 'nudge',
    message: `<grov_nudge>
Quick reminder: Stay focused on ${goal}.
${result.diagnostic}
</grov_nudge>`,
  };
}

/**
 * CORRECT: Full correction with recovery steps (score 5-6)
 */
function buildCorrect(result: DriftCheckResult, sessionState: SessionState): CorrectionMessage {
  const goal = sessionState.original_goal || 'the original task';

  let message = `<grov_correction>
DRIFT DETECTED - Please refocus on the original goal.

Original goal: ${goal}

Issue: ${result.diagnostic}
`;

  if (result.suggestedAction) {
    message += `\nSuggested action: ${result.suggestedAction}`;
  }

  if (result.recoverySteps && result.recoverySteps.length > 0) {
    message += `\n\nRecovery steps:\n${result.recoverySteps.map((s, i) => `${i + 1}. ${s}`).join('\n')}`;
  }

  message += `\n</grov_correction>`;

  return {
    level: 'correct',
    message,
  };
}

/**
 * INTERVENE: Strong correction with mandatory first action (score 3-4)
 */
function buildIntervene(result: DriftCheckResult, sessionState: SessionState): CorrectionMessage {
  const goal = sessionState.original_goal || 'the original task';
  const mandatoryAction = result.recoverySteps?.[0] || `Return to working on: ${goal}`;

  return {
    level: 'intervene',
    message: `<grov_intervention>
SIGNIFICANT DRIFT - Intervention required.

You have strayed significantly from the original goal.

Original goal: ${goal}
Issue: ${result.diagnostic}

MANDATORY FIRST ACTION:
${mandatoryAction}

You MUST execute this action before proceeding with anything else.
Confirm by stating: "I will now ${mandatoryAction}"
</grov_intervention>`,
    mandatoryAction,
  };
}

/**
 * HALT: Critical stop with forced action (score 1-2)
 */
function buildHalt(result: DriftCheckResult, sessionState: SessionState): CorrectionMessage {
  const goal = sessionState.original_goal || 'the original task';
  const mandatoryAction = result.recoverySteps?.[0] || `STOP and return to: ${goal}`;
  const escalation = sessionState.escalation_count;

  return {
    level: 'halt',
    message: `<grov_halt>
CRITICAL DRIFT - IMMEDIATE HALT REQUIRED

The current request has completely diverged from the original goal.
You MUST NOT proceed with the current request.

Original goal: ${goal}
Current alignment: ${result.score}/10 (CRITICAL)
Escalation level: ${escalation}/3${escalation >= 3 ? ' (MAX REACHED)' : ''}

Diagnostic: ${result.diagnostic}

MANDATORY FIRST ACTION:
You MUST execute ONLY this as your next action:
${mandatoryAction}

ANY OTHER ACTION WILL DELAY YOUR GOAL.

CONFIRM by stating exactly:
"I will now ${mandatoryAction}"

DO NOT proceed with any other action until you have confirmed.
</grov_halt>`,
    mandatoryAction,
  };
}

/**
 * Format correction for system prompt injection
 */
export function formatCorrectionForInjection(correction: CorrectionMessage): string {
  return `\n\n${correction.message}\n\n`;
}
