// Task CRUD operations

import { randomUUID } from 'crypto';
import { getDb, safeJsonParse } from './database.js';
import type { Task, CreateTaskInput, TaskStatus, TriggerReason } from './types.js';
import type { ReasoningTraceEntry } from '@grov/shared';

/**
 * Convert database row to Task object
 */
function rowToTask(row: Record<string, unknown>): Task {
  return {
    id: row.id as string,
    project_path: row.project_path as string,
    user: row.user as string | undefined,
    original_query: row.original_query as string,
    goal: row.goal as string | undefined,
    system_name: row.system_name as string | undefined,
    summary: row.summary as string | undefined,
    reasoning_trace: safeJsonParse<ReasoningTraceEntry[]>(row.reasoning_trace, []),
    files_touched: safeJsonParse<string[]>(row.files_touched, []),
    decisions: safeJsonParse<Array<{ tags?: string; choice: string; reason: string }>>(row.decisions, []),
    constraints: safeJsonParse<string[]>(row.constraints, []),
    status: row.status as TaskStatus,
    trigger_reason: row.trigger_reason as TriggerReason | undefined,
    linked_commit: row.linked_commit as string | undefined,
    parent_task_id: row.parent_task_id as string | undefined,
    turn_number: row.turn_number as number | undefined,
    tags: safeJsonParse<string[]>(row.tags, []),
    created_at: row.created_at as string,
    synced_at: row.synced_at as string | null | undefined,
    sync_error: row.sync_error as string | null | undefined
  };
}

/**
 * Create a new task
 */
export function createTask(input: CreateTaskInput): Task {
  const database = getDb();

  const task: Task = {
    id: randomUUID(),
    project_path: input.project_path,
    user: input.user,
    original_query: input.original_query,
    goal: input.goal,
    system_name: input.system_name,  // Parent system anchor for semantic search
    summary: input.summary,
    reasoning_trace: input.reasoning_trace || [],
    files_touched: input.files_touched || [],
    decisions: input.decisions || [],
    constraints: input.constraints || [],
    status: input.status,
    trigger_reason: input.trigger_reason,
    linked_commit: input.linked_commit,
    parent_task_id: input.parent_task_id,
    turn_number: input.turn_number,
    tags: input.tags || [],
    created_at: new Date().toISOString(),
    synced_at: null,
    sync_error: null
  };

  const stmt = database.prepare(`
    INSERT INTO tasks (
      id, project_path, user, original_query, goal, system_name, summary,
      reasoning_trace, files_touched, decisions, constraints,
      status, trigger_reason, linked_commit,
      parent_task_id, turn_number, tags, created_at, synced_at, sync_error
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?, ?, ?, ?
    )
  `);

  stmt.run(
    task.id,
    task.project_path,
    task.user || null,
    task.original_query,
    task.goal || null,
    task.system_name || null,
    task.summary || null,
    JSON.stringify(task.reasoning_trace),
    JSON.stringify(task.files_touched),
    JSON.stringify(task.decisions),
    JSON.stringify(task.constraints),
    task.status,
    task.trigger_reason || null,
    task.linked_commit || null,
    task.parent_task_id || null,
    task.turn_number || null,
    JSON.stringify(task.tags),
    task.created_at,
    task.synced_at,
    task.sync_error
  );

  return task;
}

/**
 * Get tasks for a project from LOCAL SQLite database
 *
 * Used by:
 * - `grov status` command (CLI)
 *
 * For CLOUD injection, use fetchTeamMemories() from api-client.ts instead.
 */
export function getTasksForProject(
  projectPath: string,
  options: { status?: TaskStatus; limit?: number } = {}
): Task[] {
  const database = getDb();

  let sql = 'SELECT * FROM tasks WHERE project_path = ?';
  const params: (string | number)[] = [projectPath];

  if (options.status) {
    sql += ' AND status = ?';
    params.push(options.status);
  }

  sql += ' ORDER BY created_at DESC';

  if (options.limit) {
    sql += ' LIMIT ?';
    params.push(options.limit);
  }

  const stmt = database.prepare(sql);
  const rows = stmt.all(...params) as Record<string, unknown>[];

  return rows.map(rowToTask);
}

/**
 * Get task count for a project
 */
export function getTaskCount(projectPath: string): number {
  const database = getDb();

  const stmt = database.prepare('SELECT COUNT(*) as count FROM tasks WHERE project_path = ?');
  const row = stmt.get(projectPath) as { count: number } | undefined;

  return row?.count ?? 0;
}

/**
 * Get unsynced tasks for a project (synced_at is NULL)
 */
export function getUnsyncedTasks(
  projectPath: string,
  limit?: number
): Task[] {
  const database = getDb();

  let sql = 'SELECT * FROM tasks WHERE project_path = ? AND synced_at IS NULL ORDER BY created_at DESC';
  const params: (string | number)[] = [projectPath];

  if (limit) {
    sql += ' LIMIT ?';
    params.push(limit);
  }

  const stmt = database.prepare(sql);
  const rows = stmt.all(...params) as Record<string, unknown>[];

  return rows.map(rowToTask);
}

/**
 * Mark a task as synced and clear any previous sync error
 */
export function markTaskSynced(id: string): void {
  const database = getDb();
  const now = new Date().toISOString();
  database.prepare('UPDATE tasks SET synced_at = ?, sync_error = NULL WHERE id = ?').run(now, id);
}

/**
 * Record a sync error for a task
 */
export function setTaskSyncError(id: string, error: string): void {
  const database = getDb();
  database.prepare('UPDATE tasks SET sync_error = ? WHERE id = ?').run(error, id);
}

/**
 * Get count of synced tasks
 */
export function getSyncedTaskCount(): number {
  const database = getDb();
  const stmt = database.prepare('SELECT COUNT(*) as count FROM tasks WHERE synced_at IS NOT NULL');
  const row = stmt.get() as { count: number } | undefined;
  return row?.count ?? 0;
}

/**
 * Delete oldest synced tasks to maintain storage limit
 * Called after successful sync to prevent local DB bloat
 *
 * @param maxSyncedTasks - Maximum number of synced tasks to keep (default 500)
 * @returns Number of tasks deleted
 */
export function cleanupOldSyncedTasks(maxSyncedTasks: number = 500): number {
  const database = getDb();

  const currentCount = getSyncedTaskCount();
  if (currentCount <= maxSyncedTasks) {
    return 0;
  }

  const toDelete = currentCount - maxSyncedTasks;

  // Delete oldest synced tasks (by synced_at, not created_at)
  const stmt = database.prepare(`
    DELETE FROM tasks
    WHERE id IN (
      SELECT id FROM tasks
      WHERE synced_at IS NOT NULL
      ORDER BY synced_at ASC
      LIMIT ?
    )
  `);

  const result = stmt.run(toDelete);
  return result.changes;
}
