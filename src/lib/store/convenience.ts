// Convenience wrappers and cleanup functions

import { getDb } from './database.js';
import { getSessionState, updateSessionState } from './sessions.js';
import type { SessionMode } from './types.js';

/**
 * Update token count for a session
 */
export function updateTokenCount(sessionId: string, tokenCount: number): void {
  updateSessionState(sessionId, { token_count: tokenCount });
}

/**
 * Update session mode
 */
export function updateSessionMode(sessionId: string, mode: SessionMode): void {
  updateSessionState(sessionId, { session_mode: mode });
}

/**
 * Mark session as waiting for recovery
 */
export function markWaitingForRecovery(sessionId: string, waiting: boolean): void {
  updateSessionState(sessionId, { waiting_for_recovery: waiting });
}

/**
 * Increment escalation count
 */
export function incrementEscalation(sessionId: string): void {
  const session = getSessionState(sessionId);
  if (session) {
    updateSessionState(sessionId, { escalation_count: session.escalation_count + 1 });
  }
}

/**
 * Update last clear timestamp and reset token count
 */
export function markCleared(sessionId: string): void {
  updateSessionState(sessionId, {
    last_clear_at: Date.now(),
    token_count: 0
  });
}

/**
 * Mark session as completed (instead of deleting)
 * Session will be cleaned up after 1 hour
 */
export function markSessionCompleted(sessionId: string): void {
  const database = getDb();
  const now = new Date().toISOString();
  database.prepare(`
    UPDATE session_states
    SET status = 'completed', completed_at = ?, last_update = ?
    WHERE session_id = ?
  `).run(now, now, sessionId);
}

/**
 * Cleanup sessions completed more than 24 hours ago
 * Also deletes associated steps and drift_log entries
 * Skips sessions that have active children (RESTRICT approach)
 * Returns number of sessions cleaned up
 */
export function cleanupOldCompletedSessions(maxAgeMs: number = 86400000): number {
  const database = getDb();
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();

  // Get sessions to cleanup, excluding those with active children
  const oldSessions = database.prepare(`
    SELECT session_id FROM session_states
    WHERE status = 'completed'
      AND completed_at < ?
      AND session_id NOT IN (
        SELECT DISTINCT parent_session_id
        FROM session_states
        WHERE parent_session_id IS NOT NULL
          AND status != 'completed'
      )
  `).all(cutoff) as Array<{ session_id: string }>;

  if (oldSessions.length === 0) {
    return 0;
  }

  // Delete in correct order to respect FK constraints
  for (const session of oldSessions) {
    // 1. Delete from drift_log (FK to session_states)
    database.prepare('DELETE FROM drift_log WHERE session_id = ?').run(session.session_id);
    // 2. Delete from steps (FK to session_states)
    database.prepare('DELETE FROM steps WHERE session_id = ?').run(session.session_id);
    // 3. Now safe to delete session_states
    database.prepare('DELETE FROM session_states WHERE session_id = ?').run(session.session_id);
  }

  return oldSessions.length;
}

/**
 * Cleanup stale active sessions (no activity for maxAgeMs)
 * Marks them as 'abandoned' so they won't be picked up by getActiveSessionForUser
 * This prevents old sessions from being reused in fresh Claude sessions
 * Returns number of sessions marked as abandoned
 */
export function cleanupStaleActiveSessions(maxAgeMs: number = 3600000): number {
  const database = getDb();
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
  const now = new Date().toISOString();

  const result = database.prepare(`
    UPDATE session_states
    SET status = 'abandoned', completed_at = ?
    WHERE status = 'active' AND last_update < ?
  `).run(now, cutoff);

  return result.changes;
}
