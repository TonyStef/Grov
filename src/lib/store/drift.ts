// Drift detection and drift log operations

import { randomUUID } from 'crypto';
import { getDb, safeJsonParse } from './database.js';
import { getSessionState } from './sessions.js';
import type {
  DriftLogEntry,
  CreateDriftLogInput,
  CorrectionLevel,
  RecoveryPlan,
  DriftEvent
} from './types.js';

/**
 * Convert database row to DriftLogEntry object
 */
function rowToDriftLogEntry(row: Record<string, unknown>): DriftLogEntry {
  return {
    id: row.id as string,
    session_id: row.session_id as string,
    timestamp: row.timestamp as number,
    action_type: row.action_type as string | undefined,
    files: safeJsonParse<string[]>(row.files, []),
    drift_score: row.drift_score as number,
    drift_reason: row.drift_reason as string | undefined,
    correction_given: row.correction_given as string | undefined,
    recovery_plan: row.recovery_plan ? safeJsonParse<Record<string, unknown>>(row.recovery_plan, {}) : undefined
  };
}

/**
 * Update session drift metrics after a prompt check
 */
export function updateSessionDrift(
  sessionId: string,
  driftScore: number,
  correctionLevel: CorrectionLevel | null,
  promptSummary: string,
  recoveryPlan?: RecoveryPlan
): void {
  const database = getDb();
  const session = getSessionState(sessionId);
  if (!session) return;

  const now = new Date().toISOString();

  // Calculate new escalation count
  let newEscalation = session.escalation_count;
  if (driftScore >= 8) {
    // Recovery - decrease escalation
    newEscalation = Math.max(0, newEscalation - 1);
  } else if (correctionLevel && correctionLevel !== 'nudge') {
    // Significant drift - increase escalation
    newEscalation = Math.min(3, newEscalation + 1);
  }

  // Add to drift history
  const driftEvent: DriftEvent = {
    timestamp: now,
    score: driftScore,
    level: correctionLevel || 'none',
    prompt_summary: promptSummary.substring(0, 100)
  };
  const newHistory = [...(session.drift_history || []), driftEvent];

  // Add to drift_warnings if correction was given
  const currentWarnings = session.drift_warnings || [];
  const newWarnings = correctionLevel
    ? [...currentWarnings, `[${now}] ${correctionLevel}: score ${driftScore}`]
    : currentWarnings;

  const stmt = database.prepare(`
    UPDATE session_states SET
      last_drift_score = ?,
      escalation_count = ?,
      pending_recovery_plan = ?,
      drift_history = ?,
      drift_warnings = ?,
      last_update = ?
    WHERE session_id = ?
  `);

  stmt.run(
    driftScore,
    newEscalation,
    recoveryPlan ? JSON.stringify(recoveryPlan) : null,
    JSON.stringify(newHistory),
    JSON.stringify(newWarnings),
    now,
    sessionId
  );
}

/**
 * Log a drift event (for rejected actions)
 */
export function logDriftEvent(input: CreateDriftLogInput): DriftLogEntry {
  const database = getDb();

  const entry: DriftLogEntry = {
    id: randomUUID(),
    session_id: input.session_id,
    timestamp: Date.now(),
    action_type: input.action_type,
    files: input.files || [],
    drift_score: input.drift_score,
    drift_reason: input.drift_reason,
    correction_given: input.correction_given,
    recovery_plan: input.recovery_plan
  };

  const stmt = database.prepare(`
    INSERT INTO drift_log (
      id, session_id, timestamp, action_type, files,
      drift_score, drift_reason, correction_given, recovery_plan
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    entry.id,
    entry.session_id,
    entry.timestamp,
    entry.action_type || null,
    JSON.stringify(entry.files),
    entry.drift_score,
    entry.drift_reason || null,
    entry.correction_given || null,
    entry.recovery_plan ? JSON.stringify(entry.recovery_plan) : null
  );

  return entry;
}
