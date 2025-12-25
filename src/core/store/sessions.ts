// Session state CRUD operations

import { getDb, safeJsonParse } from './database.js';
import type {
  SessionState,
  CreateSessionStateInput,
  SessionStatus,
  SessionMode,
  TaskType,
  RecoveryPlan,
  DriftEvent
} from './types.js';

/**
 * Convert database row to SessionState object
 */
function rowToSessionState(row: Record<string, unknown>): SessionState {
  return {
    // Base fields
    session_id: row.session_id as string,
    user_id: row.user_id as string | undefined,
    project_path: row.project_path as string,
    original_goal: row.original_goal as string | undefined,
    raw_user_prompt: row.raw_user_prompt as string | undefined,
    expected_scope: safeJsonParse<string[]>(row.expected_scope, []),
    constraints: safeJsonParse<string[]>(row.constraints, []),
    keywords: safeJsonParse<string[]>(row.keywords, []),
    escalation_count: (row.escalation_count as number) || 0,
    last_checked_at: (row.last_checked_at as number) || 0,
    start_time: row.start_time as string,
    last_update: row.last_update as string,
    status: row.status as SessionStatus,
    // Hook-specific fields
    success_criteria: safeJsonParse<string[]>(row.success_criteria, []),
    last_drift_score: row.last_drift_score as number | undefined,
    pending_recovery_plan: safeJsonParse<RecoveryPlan | undefined>(row.pending_recovery_plan, undefined),
    drift_history: safeJsonParse<DriftEvent[]>(row.drift_history, []),
    actions_taken: safeJsonParse<string[]>(row.actions_taken, []),
    files_explored: safeJsonParse<string[]>(row.files_explored, []),
    current_intent: row.current_intent as string | undefined,
    drift_warnings: safeJsonParse<string[]>(row.drift_warnings, []),
    // Proxy-specific fields
    token_count: (row.token_count as number) || 0,
    session_mode: (row.session_mode as SessionMode) || 'normal',
    waiting_for_recovery: Boolean(row.waiting_for_recovery),
    last_clear_at: row.last_clear_at as number | undefined,
    completed_at: row.completed_at as string | undefined,
    parent_session_id: row.parent_session_id as string | undefined,
    task_type: (row.task_type as TaskType) || 'main',
    pending_correction: row.pending_correction as string | undefined,
    pending_forced_recovery: row.pending_forced_recovery as string | undefined,
    pending_clear_summary: row.pending_clear_summary as string | undefined,
    final_response: row.final_response as string | undefined,
  };
}

/**
 * Create a new session state.
 * Uses INSERT OR IGNORE to handle race conditions safely.
 */
export function createSessionState(input: CreateSessionStateInput): SessionState {
  const database = getDb();
  const now = new Date().toISOString();

  const sessionState: SessionState = {
    // Base fields
    session_id: input.session_id,
    user_id: input.user_id,
    project_path: input.project_path,
    original_goal: input.original_goal,
    raw_user_prompt: input.raw_user_prompt,
    expected_scope: input.expected_scope || [],
    constraints: input.constraints || [],
    keywords: input.keywords || [],
    escalation_count: 0,
    last_checked_at: 0,
    start_time: now,
    last_update: now,
    status: 'active',
    // Hook-specific fields
    success_criteria: input.success_criteria || [],
    last_drift_score: undefined,
    pending_recovery_plan: undefined,
    drift_history: [],
    actions_taken: [],
    files_explored: [],
    current_intent: undefined,
    drift_warnings: [],
    // Proxy-specific fields
    token_count: 0,
    session_mode: 'normal' as SessionMode,
    waiting_for_recovery: false,
    last_clear_at: undefined,
    completed_at: undefined,
    parent_session_id: input.parent_session_id,
    task_type: input.task_type || 'main',
  };

  const stmt = database.prepare(`
    INSERT OR IGNORE INTO session_states (
      session_id, user_id, project_path, original_goal, raw_user_prompt,
      expected_scope, constraints, keywords,
      token_count, escalation_count, session_mode,
      waiting_for_recovery, last_checked_at, last_clear_at,
      start_time, last_update, status,
      parent_session_id, task_type,
      success_criteria, last_drift_score, pending_recovery_plan, drift_history,
      completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    sessionState.session_id,
    sessionState.user_id || null,
    sessionState.project_path,
    sessionState.original_goal || null,
    sessionState.raw_user_prompt || null,
    JSON.stringify(sessionState.expected_scope),
    JSON.stringify(sessionState.constraints),
    JSON.stringify(sessionState.keywords),
    sessionState.token_count,
    sessionState.escalation_count,
    sessionState.session_mode,
    sessionState.waiting_for_recovery ? 1 : 0,
    sessionState.last_checked_at,
    sessionState.last_clear_at || null,
    sessionState.start_time,
    sessionState.last_update,
    sessionState.status,
    sessionState.parent_session_id || null,
    sessionState.task_type,
    JSON.stringify(sessionState.success_criteria || []),
    sessionState.last_drift_score || null,
    sessionState.pending_recovery_plan ? JSON.stringify(sessionState.pending_recovery_plan) : null,
    JSON.stringify(sessionState.drift_history || []),
    sessionState.completed_at || null
  );

  return sessionState;
}

/**
 * Get a session state by ID
 */
export function getSessionState(sessionId: string): SessionState | null {
  const database = getDb();

  const stmt = database.prepare('SELECT * FROM session_states WHERE session_id = ?');
  const row = stmt.get(sessionId) as Record<string, unknown> | undefined;

  return row ? rowToSessionState(row) : null;
}

/**
 * Update a session state.
 * Uses transaction for atomic updates to prevent race conditions.
 */
export function updateSessionState(
  sessionId: string,
  updates: Partial<Omit<SessionState, 'session_id' | 'start_time'>>
): void {
  const database = getDb();

  const setClauses: string[] = [];
  const params: (string | number | null)[] = [];

  if (updates.user_id !== undefined) {
    setClauses.push('user_id = ?');
    params.push(updates.user_id || null);
  }
  if (updates.project_path !== undefined) {
    setClauses.push('project_path = ?');
    params.push(updates.project_path);
  }
  if (updates.original_goal !== undefined) {
    setClauses.push('original_goal = ?');
    params.push(updates.original_goal || null);
  }
  if (updates.expected_scope !== undefined) {
    setClauses.push('expected_scope = ?');
    params.push(JSON.stringify(updates.expected_scope));
  }
  if (updates.constraints !== undefined) {
    setClauses.push('constraints = ?');
    params.push(JSON.stringify(updates.constraints));
  }
  if (updates.keywords !== undefined) {
    setClauses.push('keywords = ?');
    params.push(JSON.stringify(updates.keywords));
  }
  if (updates.token_count !== undefined) {
    setClauses.push('token_count = ?');
    params.push(updates.token_count);
  }
  if (updates.escalation_count !== undefined) {
    setClauses.push('escalation_count = ?');
    params.push(updates.escalation_count);
  }
  if (updates.session_mode !== undefined) {
    setClauses.push('session_mode = ?');
    params.push(updates.session_mode);
  }
  if (updates.waiting_for_recovery !== undefined) {
    setClauses.push('waiting_for_recovery = ?');
    params.push(updates.waiting_for_recovery ? 1 : 0);
  }
  if (updates.last_checked_at !== undefined) {
    setClauses.push('last_checked_at = ?');
    params.push(updates.last_checked_at);
  }
  if (updates.last_clear_at !== undefined) {
    setClauses.push('last_clear_at = ?');
    params.push(updates.last_clear_at);
  }
  if (updates.status !== undefined) {
    setClauses.push('status = ?');
    params.push(updates.status);
  }
  if (updates.pending_correction !== undefined) {
    setClauses.push('pending_correction = ?');
    params.push(updates.pending_correction || null);
  }
  if (updates.pending_forced_recovery !== undefined) {
    setClauses.push('pending_forced_recovery = ?');
    params.push(updates.pending_forced_recovery || null);
  }
  if (updates.pending_clear_summary !== undefined) {
    setClauses.push('pending_clear_summary = ?');
    params.push(updates.pending_clear_summary || null);
  }
  if (updates.final_response !== undefined) {
    setClauses.push('final_response = ?');
    params.push(updates.final_response || null);
  }

  // Always update last_update
  setClauses.push('last_update = ?');
  params.push(new Date().toISOString());

  if (setClauses.length === 0) return;

  params.push(sessionId);
  const sql = `UPDATE session_states SET ${setClauses.join(', ')} WHERE session_id = ?`;

  const transaction = database.transaction(() => {
    database.prepare(sql).run(...params);
  });
  transaction();
}

/**
 * Delete a session state
 */
export function deleteSessionState(sessionId: string): void {
  const database = getDb();
  database.prepare('DELETE FROM session_states WHERE session_id = ?').run(sessionId);
}

/**
 * Get active session for a specific user in a project
 */
export function getActiveSessionForUser(projectPath: string, userId?: string): SessionState | null {
  const database = getDb();

  if (userId) {
    const stmt = database.prepare(
      "SELECT * FROM session_states WHERE project_path = ? AND user_id = ? AND status = 'active' ORDER BY last_update DESC LIMIT 1"
    );
    const row = stmt.get(projectPath, userId) as Record<string, unknown> | undefined;
    return row ? rowToSessionState(row) : null;
  } else {
    const stmt = database.prepare(
      "SELECT * FROM session_states WHERE project_path = ? AND status = 'active' ORDER BY last_update DESC LIMIT 1"
    );
    const row = stmt.get(projectPath) as Record<string, unknown> | undefined;
    return row ? rowToSessionState(row) : null;
  }
}

/**
 * Get all active sessions (for proxy-status command)
 */
export function getActiveSessionsForStatus(): SessionState[] {
  const database = getDb();

  const stmt = database.prepare(
    "SELECT * FROM session_states WHERE status = 'active' ORDER BY last_update DESC LIMIT 20"
  );
  const rows = stmt.all() as Record<string, unknown>[];

  return rows.map(rowToSessionState);
}

/**
 * Get completed session for project (for new_task detection)
 * Returns most recent completed session if exists
 */
export function getCompletedSessionForProject(projectPath: string): SessionState | null {
  const database = getDb();
  const row = database.prepare(`
    SELECT * FROM session_states
    WHERE project_path = ? AND status = 'completed'
    ORDER BY completed_at DESC
    LIMIT 1
  `).get(projectPath) as Record<string, unknown> | undefined;

  return row ? rowToSessionState(row) : null;
}

/**
 * Clear stale pending states from all sessions
 * Called at proxy startup to prevent stuck states from blocking new sessions
 * Resets: corrections, recovery plans, CLEAR summaries, token counts
 * Returns number of sessions cleared
 */
export function clearStalePendingCorrections(): number {
  const database = getDb();
  const result = database.prepare(`
    UPDATE session_states
    SET pending_correction = NULL,
        pending_forced_recovery = NULL,
        pending_clear_summary = NULL,
        pending_recovery_plan = NULL,
        waiting_for_recovery = 0,
        escalation_count = 0,
        session_mode = 'normal',
        token_count = 0
    WHERE pending_correction IS NOT NULL
       OR pending_forced_recovery IS NOT NULL
       OR pending_clear_summary IS NOT NULL
       OR pending_recovery_plan IS NOT NULL
       OR waiting_for_recovery = 1
       OR token_count > 0
  `).run();

  return result.changes;
}
