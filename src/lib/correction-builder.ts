// Correction message builder for anti-drift system
// Builds XML-tagged correction messages by severity level

import type { DriftCheckResult } from './drift-checker.js';
import type { SessionState, CorrectionLevel } from './store.js';
import { DRIFT_CONFIG } from './drift-checker.js';

// ============================================
// MAIN FUNCTIONS
// ============================================

/**
 * Determine correction level from score and escalation count
 */
export function determineCorrectionLevel(
  score: number,
  escalationCount: number
): CorrectionLevel | null {
  // Apply escalation modifier (each escalation level lowers threshold by 1)
  const effectiveScore = score - escalationCount;

  if (effectiveScore >= DRIFT_CONFIG.SCORE_NO_INJECTION) {
    return null; // No correction needed
  }

  if (effectiveScore >= DRIFT_CONFIG.SCORE_NUDGE) {
    return 'nudge';
  }

  if (effectiveScore >= DRIFT_CONFIG.SCORE_CORRECT) {
    return 'correct';
  }

  if (effectiveScore >= DRIFT_CONFIG.SCORE_INTERVENE) {
    return 'intervene';
  }

  return 'halt';
}

/**
 * Build correction message based on level
 */
export function buildCorrection(
  result: DriftCheckResult,
  sessionState: SessionState,
  level: CorrectionLevel
): string {
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

// ============================================
// CORRECTION BUILDERS
// ============================================

/**
 * NUDGE - Gentle 2-3 sentence reminder
 * Score ~7, first sign of drift
 */
function buildNudge(result: DriftCheckResult, sessionState: SessionState): string {
  const lines: string[] = [];

  lines.push('<grov_nudge>');
  lines.push('');
  lines.push(`Reminder: Original goal is "${truncateGoal(sessionState.original_goal)}".`);
  lines.push(`Current alignment: ${result.score}/10.`);
  if (result.diagnostic) {
    lines.push(`Note: ${result.diagnostic}`);
  }
  lines.push('');
  lines.push('</grov_nudge>');

  return lines.join('\n');
}

/**
 * CORRECT - Deviation + scope + next steps
 * Score 5-6, moderate drift
 */
function buildCorrect(result: DriftCheckResult, sessionState: SessionState): string {
  const lines: string[] = [];

  lines.push('<grov_correction>');
  lines.push('');
  lines.push('DRIFT DETECTED');
  lines.push('');
  lines.push(`Original goal: "${truncateGoal(sessionState.original_goal)}"`);
  lines.push(`Current alignment: ${result.score}/10`);
  lines.push(`Diagnostic: ${result.diagnostic}`);
  lines.push('');

  // Add scope reminder
  if (sessionState.expected_scope.length > 0) {
    lines.push('Expected scope:');
    for (const scope of sessionState.expected_scope.slice(0, 5)) {
      lines.push(`  - ${scope}`);
    }
    lines.push('');
  }

  // Add boundaries if any
  if (result.boundaries.length > 0) {
    lines.push('Boundaries (avoid):');
    for (const boundary of result.boundaries.slice(0, 3)) {
      lines.push(`  - ${boundary}`);
    }
    lines.push('');
  }

  // Add next steps
  lines.push('Suggested next steps:');
  if (result.recoveryPlan?.steps) {
    for (const step of result.recoveryPlan.steps.slice(0, 3)) {
      const file = step.file ? `[${step.file}] ` : '';
      lines.push(`  - ${file}${step.action}`);
    }
  } else {
    lines.push(`  - Return to: ${truncateGoal(sessionState.original_goal)}`);
  }
  lines.push('');
  lines.push('</grov_correction>');

  return lines.join('\n');
}

/**
 * INTERVENE - Full diagnostic + mandatory first action + confirmation request
 * Score 3-4, significant drift
 */
function buildIntervene(result: DriftCheckResult, sessionState: SessionState): string {
  const lines: string[] = [];

  lines.push('<grov_intervention>');
  lines.push('');
  lines.push('SIGNIFICANT DRIFT DETECTED - INTERVENTION REQUIRED');
  lines.push('');
  lines.push(`Original goal: "${truncateGoal(sessionState.original_goal)}"`);
  lines.push(`Current alignment: ${result.score}/10 (${result.type})`);
  lines.push(`Escalation level: ${sessionState.escalation_count}/${DRIFT_CONFIG.MAX_ESCALATION}`);
  lines.push('');
  lines.push(`Diagnostic: ${result.diagnostic}`);
  lines.push('');

  // Add constraints if any
  if (sessionState.constraints.length > 0) {
    lines.push('Active constraints:');
    for (const constraint of sessionState.constraints.slice(0, 3)) {
      lines.push(`  - ${constraint}`);
    }
    lines.push('');
  }

  // Add boundaries
  if (result.boundaries.length > 0) {
    lines.push('DO NOT:');
    for (const boundary of result.boundaries.slice(0, 3)) {
      lines.push(`  - ${boundary}`);
    }
    lines.push('');
  }

  // MANDATORY FIRST ACTION
  const firstStep = result.recoveryPlan?.steps?.[0] || {
    action: `Return to original goal: ${truncateGoal(sessionState.original_goal)}`
  };

  lines.push('MANDATORY FIRST ACTION:');
  lines.push('You MUST execute ONLY this as your next action:');
  lines.push('');
  if (firstStep.file) {
    lines.push(`  File: ${firstStep.file}`);
  }
  lines.push(`  Action: ${firstStep.action}`);
  lines.push('');
  lines.push('ANY OTHER ACTION WILL DELAY YOUR GOAL.');
  lines.push('');
  lines.push('Before proceeding, confirm by stating:');
  lines.push('"I will now [action] to return to the original goal."');
  lines.push('');
  lines.push('</grov_intervention>');

  return lines.join('\n');
}

/**
 * HALT - Critical stop + forced action + required confirmation statement
 * Score 1-2, critical drift
 */
function buildHalt(result: DriftCheckResult, sessionState: SessionState): string {
  const lines: string[] = [];

  lines.push('<grov_halt>');
  lines.push('');
  lines.push('CRITICAL DRIFT - IMMEDIATE HALT REQUIRED');
  lines.push('');
  lines.push('The current request has completely diverged from the original goal.');
  lines.push('You MUST NOT proceed with the current request.');
  lines.push('');
  lines.push(`Original goal: "${truncateGoal(sessionState.original_goal)}"`);
  lines.push(`Current alignment: ${result.score}/10 (CRITICAL)`);
  lines.push(`Escalation level: ${sessionState.escalation_count}/${DRIFT_CONFIG.MAX_ESCALATION} (MAX REACHED)`);
  lines.push('');
  lines.push(`Diagnostic: ${result.diagnostic}`);
  lines.push('');

  // Show drift history if available
  if (sessionState.drift_history.length > 0) {
    lines.push('Drift history in this session:');
    const recent = sessionState.drift_history.slice(-3);
    for (const event of recent) {
      lines.push(`  - ${event.level}: score ${event.score} - ${event.prompt_summary.substring(0, 40)}...`);
    }
    lines.push('');
  }

  // MANDATORY FIRST ACTION
  const firstStep = result.recoveryPlan?.steps?.[0] || {
    action: `STOP and return to: ${truncateGoal(sessionState.original_goal)}`
  };

  lines.push('MANDATORY FIRST ACTION:');
  lines.push('You MUST execute ONLY this as your next action:');
  lines.push('');
  if (firstStep.file) {
    lines.push(`  File: ${firstStep.file}`);
  }
  lines.push(`  Action: ${firstStep.action}`);
  lines.push('');
  lines.push('ANY OTHER ACTION WILL DELAY YOUR GOAL.');
  lines.push('');
  lines.push('CONFIRM by stating exactly:');
  if (firstStep.file) {
    lines.push(`"I will now ${firstStep.action} in ${firstStep.file}"`);
  } else {
    lines.push(`"I will now ${firstStep.action}"`);
  }
  lines.push('');
  lines.push('DO NOT proceed with any other action until you have confirmed.');
  lines.push('');
  lines.push('</grov_halt>');

  return lines.join('\n');
}

// ============================================
// HELPERS
// ============================================

/**
 * Truncate goal text for display
 */
function truncateGoal(goal: string | undefined): string {
  if (!goal) return 'Unknown goal';
  if (goal.length <= 80) return goal;
  return goal.substring(0, 77) + '...';
}
