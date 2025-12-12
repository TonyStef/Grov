// SQLite store for task reasoning at ~/.grov/memory.db

import Database from 'better-sqlite3';
import { existsSync, mkdirSync, chmodSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';

/**
 * Escape LIKE pattern special characters to prevent SQL injection.
 * SECURITY: Prevents wildcard injection in LIKE queries.
 */
function escapeLikePattern(str: string): string {
  return str.replace(/[%_\\]/g, '\\$&');
}

const GROV_DIR = join(homedir(), '.grov');
const DB_PATH = join(GROV_DIR, 'memory.db');

// Task status types
export type TaskStatus = 'complete' | 'question' | 'partial' | 'abandoned';

// Task trigger reasons (when saving to team memory)
export type TriggerReason = 'complete' | 'threshold' | 'abandoned';

// Task data structure (team memory)
export interface Task {
  id: string;
  project_path: string;
  user?: string;
  original_query: string;
  goal?: string;
  reasoning_trace: string[];
  files_touched: string[];
  decisions: Array<{ choice: string; reason: string }>;
  constraints: string[];
  status: TaskStatus;
  trigger_reason?: TriggerReason;
  linked_commit?: string;
  parent_task_id?: string;
  turn_number?: number;
  tags: string[];
  created_at: string;
  synced_at?: string | null;
  sync_error?: string | null;
}

// Input for creating a new task
export interface CreateTaskInput {
  project_path: string;
  user?: string;
  original_query: string;
  goal?: string;
  reasoning_trace?: string[];
  files_touched?: string[];
  decisions?: Array<{ choice: string; reason: string }>;
  constraints?: string[];
  status: TaskStatus;
  trigger_reason?: TriggerReason;
  linked_commit?: string;
  parent_task_id?: string;
  turn_number?: number;
  tags?: string[];
}

// Session state status types
export type SessionStatus = 'active' | 'completed' | 'abandoned';

// Session mode for drift state machine
export type SessionMode = 'normal' | 'drifted' | 'forced';

// Task type for session hierarchy
export type TaskType = 'main' | 'subtask' | 'parallel';

// Recovery plan for drift correction (hook uses)
export interface RecoveryPlan {
  steps: Array<{
    file?: string;
    action: string;
  }>;
}

// Drift event tracked per prompt (hook uses)
export interface DriftEvent {
  timestamp: string;
  score: number;
  level: string;
  prompt_summary: string;
}

// ============================================
// SESSION STATE - Composition Pattern
// Base + HookFields + ProxyFields
// ============================================

// Base fields (used by both hook and proxy)
interface SessionStateBase {
  session_id: string;
  user_id?: string;
  project_path: string;
  original_goal?: string;
  expected_scope: string[];
  constraints: string[];
  keywords: string[];
  escalation_count: number;
  last_checked_at: number;
  start_time: string;
  last_update: string;
  status: SessionStatus;
}

// Hook-specific fields (drift detection)
interface HookFields {
  success_criteria?: string[];
  last_drift_score?: number;
  pending_recovery_plan?: RecoveryPlan;
  drift_history?: DriftEvent[];
  // Additional hook fields
  actions_taken?: string[];
  files_explored?: string[];
  current_intent?: string;
  drift_warnings?: string[];
}

// Proxy-specific fields (session management)
interface ProxyFields {
  token_count?: number;
  session_mode?: SessionMode;
  waiting_for_recovery?: boolean;
  last_clear_at?: number;
  completed_at?: string;
  parent_session_id?: string;
  task_type?: TaskType;
  pending_correction?: string;  // Pre-computed drift correction for next request
  pending_forced_recovery?: string;  // Pre-computed Haiku recovery for escalation >= 3
  pending_clear_summary?: string;  // Pre-computed summary for CLEAR mode (generated at 85% threshold)
  cached_injection?: string;  // Cached team context injection (must be identical across session for cache)
  final_response?: string;  // Final Claude response text (for reasoning extraction in Q&A tasks)
}

// Full SessionState type (union of all)
export interface SessionState extends SessionStateBase, HookFields, ProxyFields {}

// Input for creating a new session state
export interface CreateSessionStateInput {
  session_id: string;
  user_id?: string;
  project_path: string;
  original_goal?: string;
  // Shared fields
  expected_scope?: string[];
  constraints?: string[];
  keywords?: string[];
  // Hook-specific
  success_criteria?: string[];
  // Proxy-specific
  parent_session_id?: string;
  task_type?: TaskType;
}

// Step action types
export type StepActionType = 'edit' | 'write' | 'bash' | 'read' | 'glob' | 'grep' | 'task' | 'other';

// Drift type classification
export type DriftType = 'none' | 'minor' | 'major' | 'critical';

// Correction level
export type CorrectionLevel = 'nudge' | 'correct' | 'intervene' | 'halt';

// Step record (action log for current session)
export interface StepRecord {
  id: string;
  session_id: string;
  action_type: StepActionType;
  files: string[];
  folders: string[];
  command?: string;
  reasoning?: string;  // Claude's explanation for this action
  drift_score?: number;
  drift_type?: DriftType;
  is_key_decision: boolean;
  is_validated: boolean;
  correction_given?: string;
  correction_level?: CorrectionLevel;
  keywords: string[];
  timestamp: number;
}

// Input for creating a step
export interface CreateStepInput {
  session_id: string;
  action_type: StepActionType;
  files?: string[];
  folders?: string[];
  command?: string;
  reasoning?: string;  // Claude's explanation for this action
  drift_score?: number;
  drift_type?: DriftType;
  is_key_decision?: boolean;
  is_validated?: boolean;
  correction_given?: string;
  correction_level?: CorrectionLevel;
  keywords?: string[];
}

// Drift log entry (for rejected actions)
export interface DriftLogEntry {
  id: string;
  session_id: string;
  timestamp: number;
  action_type?: string;
  files: string[];
  drift_score: number;
  drift_reason?: string;
  correction_given?: string;
  recovery_plan?: Record<string, unknown>;
}

// Input for creating drift log entry
export interface CreateDriftLogInput {
  session_id: string;
  action_type?: string;
  files?: string[];
  drift_score: number;
  drift_reason?: string;
  correction_given?: string;
  recovery_plan?: Record<string, unknown>;
}

let db: Database.Database | null = null;

/**
 * Initialize the database connection and create tables
 */
export function initDatabase(): Database.Database {
  if (db) return db;

  // Ensure .grov directory exists with secure permissions
  if (!existsSync(GROV_DIR)) {
    mkdirSync(GROV_DIR, { recursive: true, mode: 0o700 });
  }

  db = new Database(DB_PATH);

  // Set secure file permissions on the database
  try {
    chmodSync(DB_PATH, 0o600);
  } catch {
    // SECURITY: Warn user if permissions can't be set (e.g., on Windows)
    // The database may be world-readable on some systems
    console.warn('Warning: Could not set restrictive permissions on ~/.grov/memory.db');
    console.warn('Please ensure the file has appropriate permissions for your system.');
  }

  // OPTIMIZATION: Enable WAL mode for better concurrent performance
  db.pragma('journal_mode = WAL');

  // Create all tables in a single transaction for efficiency
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      project_path TEXT NOT NULL,
      user TEXT,
      original_query TEXT NOT NULL,
      goal TEXT,
      reasoning_trace JSON DEFAULT '[]',
      files_touched JSON DEFAULT '[]',
      decisions JSON DEFAULT '[]',
      constraints JSON DEFAULT '[]',
      status TEXT NOT NULL CHECK(status IN ('complete', 'question', 'partial', 'abandoned')),
      trigger_reason TEXT CHECK(trigger_reason IN ('complete', 'threshold', 'abandoned')),
      linked_commit TEXT,
      parent_task_id TEXT,
      turn_number INTEGER,
      tags JSON DEFAULT '[]',
      created_at TEXT NOT NULL,
      synced_at TEXT,
      sync_error TEXT,
      FOREIGN KEY (parent_task_id) REFERENCES tasks(id)
    );

    CREATE INDEX IF NOT EXISTS idx_project ON tasks(project_path);
    CREATE INDEX IF NOT EXISTS idx_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_created ON tasks(created_at);
  `);

  // Migration: add new columns to existing tasks table
  try {
    db.exec(`ALTER TABLE tasks ADD COLUMN decisions JSON DEFAULT '[]'`);
  } catch { /* column exists */ }
  try {
    db.exec(`ALTER TABLE tasks ADD COLUMN constraints JSON DEFAULT '[]'`);
  } catch { /* column exists */ }
  try {
    db.exec(`ALTER TABLE tasks ADD COLUMN trigger_reason TEXT`);
  } catch { /* column exists */ }
  try {
    db.exec(`ALTER TABLE tasks ADD COLUMN synced_at TEXT`);
  } catch { /* column exists */ }
  try {
    db.exec(`ALTER TABLE tasks ADD COLUMN sync_error TEXT`);
  } catch { /* column exists */ }

  // Create session_states table (temporary per-session tracking)
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_states (
      session_id TEXT PRIMARY KEY,
      user_id TEXT,
      project_path TEXT NOT NULL,
      original_goal TEXT,
      expected_scope JSON DEFAULT '[]',
      constraints JSON DEFAULT '[]',
      keywords JSON DEFAULT '[]',
      token_count INTEGER DEFAULT 0,
      escalation_count INTEGER DEFAULT 0,
      session_mode TEXT DEFAULT 'normal' CHECK(session_mode IN ('normal', 'drifted', 'forced')),
      waiting_for_recovery INTEGER DEFAULT 0,
      last_checked_at INTEGER DEFAULT 0,
      last_clear_at INTEGER,
      start_time TEXT NOT NULL,
      last_update TEXT NOT NULL,
      status TEXT DEFAULT 'active' CHECK(status IN ('active', 'completed', 'abandoned')),
      completed_at TEXT,
      parent_session_id TEXT,
      task_type TEXT DEFAULT 'main' CHECK(task_type IN ('main', 'subtask', 'parallel')),
      pending_correction TEXT,
      FOREIGN KEY (parent_session_id) REFERENCES session_states(session_id)
    );

    CREATE INDEX IF NOT EXISTS idx_session_project ON session_states(project_path);
    CREATE INDEX IF NOT EXISTS idx_session_status ON session_states(status);
    CREATE INDEX IF NOT EXISTS idx_session_parent ON session_states(parent_session_id);
  `);

  // Migration: add new columns to existing session_states table
  try {
    db.exec(`ALTER TABLE session_states ADD COLUMN expected_scope JSON DEFAULT '[]'`);
  } catch { /* column exists */ }
  try {
    db.exec(`ALTER TABLE session_states ADD COLUMN constraints JSON DEFAULT '[]'`);
  } catch { /* column exists */ }
  try {
    db.exec(`ALTER TABLE session_states ADD COLUMN keywords JSON DEFAULT '[]'`);
  } catch { /* column exists */ }
  try {
    db.exec(`ALTER TABLE session_states ADD COLUMN token_count INTEGER DEFAULT 0`);
  } catch { /* column exists */ }
  try {
    db.exec(`ALTER TABLE session_states ADD COLUMN escalation_count INTEGER DEFAULT 0`);
  } catch { /* column exists */ }
  try {
    db.exec(`ALTER TABLE session_states ADD COLUMN session_mode TEXT DEFAULT 'normal'`);
  } catch { /* column exists */ }
  try {
    db.exec(`ALTER TABLE session_states ADD COLUMN waiting_for_recovery INTEGER DEFAULT 0`);
  } catch { /* column exists */ }
  try {
    db.exec(`ALTER TABLE session_states ADD COLUMN last_checked_at INTEGER DEFAULT 0`);
  } catch { /* column exists */ }
  try {
    db.exec(`ALTER TABLE session_states ADD COLUMN last_clear_at INTEGER`);
  } catch { /* column exists */ }
  try {
    db.exec(`ALTER TABLE session_states ADD COLUMN parent_session_id TEXT`);
  } catch { /* column exists */ }
  try {
    db.exec(`ALTER TABLE session_states ADD COLUMN task_type TEXT DEFAULT 'main'`);
  } catch { /* column exists */ }
  try {
    db.exec(`ALTER TABLE session_states ADD COLUMN completed_at TEXT`);
  } catch { /* column exists */ }
  try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_session_parent ON session_states(parent_session_id)`);
  } catch { /* index exists */ }
  try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_session_completed ON session_states(completed_at)`);
  } catch { /* index exists */ }

  // Create file_reasoning table (file-level reasoning with anchoring)
  db.exec(`
    CREATE TABLE IF NOT EXISTS file_reasoning (
      id TEXT PRIMARY KEY,
      task_id TEXT,
      file_path TEXT NOT NULL,
      anchor TEXT,
      line_start INTEGER,
      line_end INTEGER,
      code_hash TEXT,
      change_type TEXT CHECK(change_type IN ('read', 'write', 'edit', 'create', 'delete')),
      reasoning TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (task_id) REFERENCES tasks(id)
    );

    CREATE INDEX IF NOT EXISTS idx_file_task ON file_reasoning(task_id);
    CREATE INDEX IF NOT EXISTS idx_file_path ON file_reasoning(file_path);
    -- PERFORMANCE: Composite index for common query pattern (file_path + ORDER BY created_at)
    CREATE INDEX IF NOT EXISTS idx_file_path_created ON file_reasoning(file_path, created_at DESC);
  `);

  // Migration: Add drift detection columns to session_states (safe to run multiple times)
  const columns = db.pragma('table_info(session_states)') as Array<{ name: string }>;
  const existingColumns = new Set(columns.map(c => c.name));

  // Shared columns
  if (!existingColumns.has('expected_scope')) {
    db.exec(`ALTER TABLE session_states ADD COLUMN expected_scope JSON DEFAULT '[]'`);
  }
  if (!existingColumns.has('constraints')) {
    db.exec(`ALTER TABLE session_states ADD COLUMN constraints JSON DEFAULT '[]'`);
  }
  if (!existingColumns.has('keywords')) {
    db.exec(`ALTER TABLE session_states ADD COLUMN keywords JSON DEFAULT '[]'`);
  }
  if (!existingColumns.has('escalation_count')) {
    db.exec(`ALTER TABLE session_states ADD COLUMN escalation_count INTEGER DEFAULT 0`);
  }
  if (!existingColumns.has('last_checked_at')) {
    db.exec(`ALTER TABLE session_states ADD COLUMN last_checked_at INTEGER DEFAULT 0`);
  }
  // Hook-specific columns
  if (!existingColumns.has('success_criteria')) {
    db.exec(`ALTER TABLE session_states ADD COLUMN success_criteria JSON DEFAULT '[]'`);
  }
  if (!existingColumns.has('last_drift_score')) {
    db.exec(`ALTER TABLE session_states ADD COLUMN last_drift_score INTEGER`);
  }
  if (!existingColumns.has('pending_recovery_plan')) {
    db.exec(`ALTER TABLE session_states ADD COLUMN pending_recovery_plan JSON`);
  }
  if (!existingColumns.has('drift_history')) {
    db.exec(`ALTER TABLE session_states ADD COLUMN drift_history JSON DEFAULT '[]'`);
  }
  // Proxy-specific columns
  if (!existingColumns.has('token_count')) {
    db.exec(`ALTER TABLE session_states ADD COLUMN token_count INTEGER DEFAULT 0`);
  }
  if (!existingColumns.has('session_mode')) {
    db.exec(`ALTER TABLE session_states ADD COLUMN session_mode TEXT DEFAULT 'normal'`);
  }
  if (!existingColumns.has('waiting_for_recovery')) {
    db.exec(`ALTER TABLE session_states ADD COLUMN waiting_for_recovery INTEGER DEFAULT 0`);
  }
  if (!existingColumns.has('last_clear_at')) {
    db.exec(`ALTER TABLE session_states ADD COLUMN last_clear_at INTEGER`);
  }
  if (!existingColumns.has('completed_at')) {
    db.exec(`ALTER TABLE session_states ADD COLUMN completed_at TEXT`);
  }
  if (!existingColumns.has('parent_session_id')) {
    db.exec(`ALTER TABLE session_states ADD COLUMN parent_session_id TEXT`);
  }
  if (!existingColumns.has('task_type')) {
    db.exec(`ALTER TABLE session_states ADD COLUMN task_type TEXT DEFAULT 'main'`);
  }
  // Additional hook fields
  if (!existingColumns.has('actions_taken')) {
    db.exec(`ALTER TABLE session_states ADD COLUMN actions_taken JSON DEFAULT '[]'`);
  }
  if (!existingColumns.has('files_explored')) {
    db.exec(`ALTER TABLE session_states ADD COLUMN files_explored JSON DEFAULT '[]'`);
  }
  if (!existingColumns.has('current_intent')) {
    db.exec(`ALTER TABLE session_states ADD COLUMN current_intent TEXT`);
  }
  if (!existingColumns.has('drift_warnings')) {
    db.exec(`ALTER TABLE session_states ADD COLUMN drift_warnings JSON DEFAULT '[]'`);
  }
  if (!existingColumns.has('pending_correction')) {
    db.exec(`ALTER TABLE session_states ADD COLUMN pending_correction TEXT`);
  }
  if (!existingColumns.has('pending_clear_summary')) {
    db.exec(`ALTER TABLE session_states ADD COLUMN pending_clear_summary TEXT`);
  }
  if (!existingColumns.has('pending_forced_recovery')) {
    db.exec(`ALTER TABLE session_states ADD COLUMN pending_forced_recovery TEXT`);
  }
  if (!existingColumns.has('final_response')) {
    db.exec(`ALTER TABLE session_states ADD COLUMN final_response TEXT`);
  }

  // Create steps table (action log for current session)
  db.exec(`
    CREATE TABLE IF NOT EXISTS steps (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      action_type TEXT NOT NULL CHECK(action_type IN ('edit', 'write', 'bash', 'read', 'glob', 'grep', 'task', 'other')),
      files JSON DEFAULT '[]',
      folders JSON DEFAULT '[]',
      command TEXT,
      reasoning TEXT,
      drift_score INTEGER,
      drift_type TEXT CHECK(drift_type IN ('none', 'minor', 'major', 'critical')),
      is_key_decision INTEGER DEFAULT 0,
      is_validated INTEGER DEFAULT 1,
      correction_given TEXT,
      correction_level TEXT CHECK(correction_level IN ('nudge', 'correct', 'intervene', 'halt')),
      keywords JSON DEFAULT '[]',
      timestamp INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES session_states(session_id)
    );
    CREATE INDEX IF NOT EXISTS idx_steps_session ON steps(session_id);
    CREATE INDEX IF NOT EXISTS idx_steps_timestamp ON steps(timestamp);
  `);

  // Migration: add new columns to existing steps table
  try {
    db.exec(`ALTER TABLE steps ADD COLUMN drift_type TEXT`);
  } catch { /* column exists */ }
  try {
    db.exec(`ALTER TABLE steps ADD COLUMN is_key_decision INTEGER DEFAULT 0`);
  } catch { /* column exists */ }
  try {
    db.exec(`ALTER TABLE steps ADD COLUMN is_validated INTEGER DEFAULT 1`);
  } catch { /* column exists */ }
  try {
    db.exec(`ALTER TABLE steps ADD COLUMN correction_given TEXT`);
  } catch { /* column exists */ }
  try {
    db.exec(`ALTER TABLE steps ADD COLUMN correction_level TEXT`);
  } catch { /* column exists */ }
  try {
    db.exec(`ALTER TABLE steps ADD COLUMN keywords JSON DEFAULT '[]'`);
  } catch { /* column exists */ }
  try {
    db.exec(`ALTER TABLE steps ADD COLUMN reasoning TEXT`);
  } catch { /* column exists */ }

  // Create drift_log table (rejected actions for audit)
  db.exec(`
    CREATE TABLE IF NOT EXISTS drift_log (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      action_type TEXT,
      files JSON DEFAULT '[]',
      drift_score INTEGER NOT NULL,
      drift_reason TEXT,
      correction_given TEXT,
      recovery_plan JSON,
      FOREIGN KEY (session_id) REFERENCES session_states(session_id)
    );

    CREATE INDEX IF NOT EXISTS idx_drift_log_session ON drift_log(session_id);
    CREATE INDEX IF NOT EXISTS idx_drift_log_timestamp ON drift_log(timestamp);
  `);

  return db;
}

/**
 * Close the database connection
 */
export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}

/**
 * Create a new task
 */
export function createTask(input: CreateTaskInput): Task {
  const database = initDatabase();

  const task: Task = {
    id: randomUUID(),
    project_path: input.project_path,
    user: input.user,
    original_query: input.original_query,
    goal: input.goal,
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
      id, project_path, user, original_query, goal,
      reasoning_trace, files_touched, decisions, constraints,
      status, trigger_reason, linked_commit,
      parent_task_id, turn_number, tags, created_at, synced_at, sync_error
    ) VALUES (
      ?, ?, ?, ?, ?,
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
  const database = initDatabase();

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
  const database = initDatabase();

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
  const database = initDatabase();

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
  const database = initDatabase();
  const now = new Date().toISOString();
  database.prepare('UPDATE tasks SET synced_at = ?, sync_error = NULL WHERE id = ?').run(now, id);
}

/**
 * Record a sync error for a task
 */
export function setTaskSyncError(id: string, error: string): void {
  const database = initDatabase();
  database.prepare('UPDATE tasks SET sync_error = ? WHERE id = ?').run(error, id);
}

/**
 * Safely parse JSON with fallback to empty array.
 */
function safeJsonParse<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || !value) {
    return fallback;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

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
    reasoning_trace: safeJsonParse<string[]>(row.reasoning_trace, []),
    files_touched: safeJsonParse<string[]>(row.files_touched, []),
    decisions: safeJsonParse<Array<{ choice: string; reason: string }>>(row.decisions, []),
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

// ============================================
// SESSION STATE CRUD OPERATIONS
// ============================================

/**
 * Create a new session state.
 * FIXED: Uses INSERT OR IGNORE to handle race conditions safely.
 */
export function createSessionState(input: CreateSessionStateInput): SessionState {
  const database = initDatabase();
  const now = new Date().toISOString();

  const sessionState: SessionState = {
    // Base fields
    session_id: input.session_id,
    user_id: input.user_id,
    project_path: input.project_path,
    original_goal: input.original_goal,
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
      session_id, user_id, project_path, original_goal,
      expected_scope, constraints, keywords,
      token_count, escalation_count, session_mode,
      waiting_for_recovery, last_checked_at, last_clear_at,
      start_time, last_update, status,
      parent_session_id, task_type,
      success_criteria, last_drift_score, pending_recovery_plan, drift_history,
      completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    sessionState.session_id,
    sessionState.user_id || null,
    sessionState.project_path,
    sessionState.original_goal || null,
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
  const database = initDatabase();

  const stmt = database.prepare('SELECT * FROM session_states WHERE session_id = ?');
  const row = stmt.get(sessionId) as Record<string, unknown> | undefined;

  return row ? rowToSessionState(row) : null;
}

/**
 * Update a session state.
 * SECURITY: Uses transaction for atomic updates to prevent race conditions.
 */
export function updateSessionState(
  sessionId: string,
  updates: Partial<Omit<SessionState, 'session_id' | 'start_time'>>
): void {
  const database = initDatabase();

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

  // SECURITY: Use transaction for atomic updates to prevent race conditions
  const transaction = database.transaction(() => {
    database.prepare(sql).run(...params);
  });
  transaction();
}

/**
 * Delete a session state
 */
export function deleteSessionState(sessionId: string): void {
  const database = initDatabase();
  database.prepare('DELETE FROM session_states WHERE session_id = ?').run(sessionId);
}

/**
 * Get active session for a specific user in a project
 */
export function getActiveSessionForUser(projectPath: string, userId?: string): SessionState | null {
  const database = initDatabase();

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
  const database = initDatabase();

  const stmt = database.prepare(
    "SELECT * FROM session_states WHERE status = 'active' ORDER BY last_update DESC LIMIT 20"
  );
  const rows = stmt.all() as Record<string, unknown>[];

  return rows.map(rowToSessionState);
}

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

// ============================================
// DRIFT DETECTION OPERATIONS (hook uses these)
// ============================================

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
  const database = initDatabase();
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
 * Get the database path
 */
export function getDatabasePath(): string {
  return DB_PATH;
}

// ============================================
// STEPS CRUD OPERATIONS (Proxy uses these)
// ============================================

/**
 * Create a new step record (proxy version)
 */
export function createStep(input: CreateStepInput): StepRecord {
  const database = initDatabase();

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
  const database = initDatabase();

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
  const database = initDatabase();

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
  const database = initDatabase();

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
  const database = initDatabase();

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
  const database = initDatabase();
  database.prepare('DELETE FROM steps WHERE session_id = ?').run(sessionId);
}

/**
 * Update reasoning for recent steps that don't have reasoning yet
 * Called at end_turn to backfill reasoning from Claude's text response
 */
export function updateRecentStepsReasoning(sessionId: string, reasoning: string, limit = 10): number {
  const database = initDatabase();

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
 * Convert database row to StepRecord object (proxy version - all fields)
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
 * Update last_checked_at timestamp for a session
 */
export function updateLastChecked(sessionId: string, timestamp: number): void {
  const database = initDatabase();
  database.prepare(`
    UPDATE session_states SET last_checked_at = ? WHERE session_id = ?
  `).run(timestamp, sessionId);
}

// ============================================
// DRIFT LOG CRUD OPERATIONS (Proxy uses these)
// ============================================

/**
 * Log a drift event (for rejected actions)
 */
export function logDriftEvent(input: CreateDriftLogInput): DriftLogEntry {
  const database = initDatabase();

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

// ============================================
// CONVENIENCE FUNCTIONS FOR PROXY
// ============================================

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
  const database = initDatabase();
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
  const database = initDatabase();
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();

  // Get sessions to cleanup, excluding those with active children
  // RESTRICT approach: don't delete parent if children still active
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
  const database = initDatabase();
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
  const now = new Date().toISOString();

  const result = database.prepare(`
    UPDATE session_states
    SET status = 'abandoned', completed_at = ?
    WHERE status = 'active' AND last_update < ?
  `).run(now, cutoff);

  return result.changes;
}

/**
 * Get completed session for project (for new_task detection)
 * Returns most recent completed session if exists
 */
export function getCompletedSessionForProject(projectPath: string): SessionState | null {
  const database = initDatabase();
  const row = database.prepare(`
    SELECT * FROM session_states
    WHERE project_path = ? AND status = 'completed'
    ORDER BY completed_at DESC
    LIMIT 1
  `).get(projectPath) as Record<string, unknown> | undefined;

  return row ? rowToSessionState(row) : null;
}
