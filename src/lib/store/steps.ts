// Step record CRUD operations

import { randomUUID } from 'crypto';
import { getDb, safeJsonParse } from './database.js';
import type {
  StepRecord,
  CreateStepInput,
  StepActionType,
  DriftType,
  CorrectionLevel
} from './types.js';

/**
 * Convert database row to StepRecord object
 */
function rowToStep(row: Record<string, unknown>): StepRecord {
  return {
    id: row.id as string,
    session_id: row.session_id as string,
    action_type: row.action_type as StepActionType,
    files: safeJsonParse<string[]>(row.files, []),
    folders: safeJsonParse<string[]>(row.folders, []),
    command: row.command as string | undefined,
    reasoning: row.reasoning as string | undefined,
    drift_score: row.drift_score as number | undefined,
    drift_type: row.drift_type as DriftType | undefined,
    is_key_decision: Boolean(row.is_key_decision),
    is_validated: Boolean(row.is_validated),
    correction_given: row.correction_given as string | undefined,
    correction_level: row.correction_level as CorrectionLevel | undefined,
    keywords: safeJsonParse<string[]>(row.keywords, []),
    timestamp: row.timestamp as number
  };
}

/**
 * Create a new step record
 */
export function createStep(input: CreateStepInput): StepRecord {
  const database = getDb();

  const step: StepRecord = {
    id: randomUUID(),
    session_id: input.session_id,
    action_type: input.action_type,
    files: input.files || [],
    folders: input.folders || [],
    command: input.command,
    reasoning: input.reasoning,
    drift_score: input.drift_score,
    drift_type: input.drift_type,
    is_key_decision: input.is_key_decision || false,
    is_validated: input.is_validated !== false,
    correction_given: input.correction_given,
    correction_level: input.correction_level,
    keywords: input.keywords || [],
    timestamp: Date.now()
  };

  const stmt = database.prepare(`
    INSERT INTO steps (
      id, session_id, action_type, files, folders, command, reasoning,
      drift_score, drift_type, is_key_decision, is_validated,
      correction_given, correction_level, keywords, timestamp
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    step.id,
    step.session_id,
    step.action_type,
    JSON.stringify(step.files),
    JSON.stringify(step.folders),
    step.command || null,
    step.reasoning || null,
    step.drift_score || null,
    step.drift_type || null,
    step.is_key_decision ? 1 : 0,
    step.is_validated ? 1 : 0,
    step.correction_given || null,
    step.correction_level || null,
    JSON.stringify(step.keywords),
    step.timestamp
  );

  return step;
}

/**
 * Get steps for a session
 */
export function getStepsForSession(sessionId: string, limit?: number): StepRecord[] {
  const database = getDb();

  let sql = 'SELECT * FROM steps WHERE session_id = ? ORDER BY timestamp DESC';
  const params: (string | number)[] = [sessionId];

  if (limit) {
    sql += ' LIMIT ?';
    params.push(limit);
  }

  const stmt = database.prepare(sql);
  const rows = stmt.all(...params) as Record<string, unknown>[];

  return rows.map(rowToStep);
}

/**
 * Get recent steps for a session (most recent N)
 */
export function getRecentSteps(sessionId: string, count = 10): StepRecord[] {
  return getStepsForSession(sessionId, count);
}

/**
 * Get validated steps only (for summary generation)
 */
export function getValidatedSteps(sessionId: string): StepRecord[] {
  const database = getDb();

  const stmt = database.prepare(
    'SELECT * FROM steps WHERE session_id = ? AND is_validated = 1 ORDER BY timestamp ASC'
  );
  const rows = stmt.all(sessionId) as Record<string, unknown>[];

  return rows.map(rowToStep);
}

/**
 * Get key decision steps for a session (is_key_decision = 1)
 * Used for user message injection - important decisions with reasoning
 */
export function getKeyDecisions(sessionId: string, limit = 5): StepRecord[] {
  const database = getDb();

  const stmt = database.prepare(
    `SELECT * FROM steps
     WHERE session_id = ? AND is_key_decision = 1 AND reasoning IS NOT NULL
     ORDER BY timestamp DESC
     LIMIT ?`
  );
  const rows = stmt.all(sessionId, limit) as Record<string, unknown>[];

  return rows.map(rowToStep);
}

/**
 * Get edited files for a session (action_type IN ('edit', 'write'))
 * Used for user message injection - prevent re-work
 */
export function getEditedFiles(sessionId: string): string[] {
  const database = getDb();

  const stmt = database.prepare(
    `SELECT DISTINCT files FROM steps
     WHERE session_id = ? AND action_type IN ('edit', 'write')
     ORDER BY timestamp DESC`
  );
  const rows = stmt.all(sessionId) as Array<{ files: string }>;

  const allFiles: string[] = [];
  for (const row of rows) {
    try {
      const files = JSON.parse(row.files || '[]');
      if (Array.isArray(files)) {
        allFiles.push(...files);
      }
    } catch {
      // Skip invalid JSON
    }
  }

  return [...new Set(allFiles)];
}

/**
 * Delete steps for a session
 */
export function deleteStepsForSession(sessionId: string): void {
  const database = getDb();
  database.prepare('DELETE FROM steps WHERE session_id = ?').run(sessionId);
}

/**
 * Update reasoning for recent steps that don't have reasoning yet
 * Called at end_turn to backfill reasoning from Claude's text response
 */
export function updateRecentStepsReasoning(sessionId: string, reasoning: string, limit = 10): number {
  const database = getDb();

  const stmt = database.prepare(`
    UPDATE steps
    SET reasoning = ?
    WHERE session_id = ?
    AND (reasoning IS NULL OR reasoning = '')
    AND id IN (
      SELECT id FROM steps
      WHERE session_id = ?
      ORDER BY timestamp DESC
      LIMIT ?
    )
  `);

  const result = stmt.run(reasoning, sessionId, sessionId, limit);
  return result.changes;
}

/**
 * Update last_checked_at timestamp for a session
 */
export function updateLastChecked(sessionId: string, timestamp: number): void {
  const database = getDb();
  database.prepare(`
    UPDATE session_states SET last_checked_at = ? WHERE session_id = ?
  `).run(timestamp, sessionId);
}
