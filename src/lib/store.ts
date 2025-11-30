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

// Session state for per-session tracking (temporary)
export interface SessionState {
  session_id: string;
  user_id?: string;
  project_path: string;
  original_goal?: string;
  expected_scope: string[];
  constraints: string[];
  keywords: string[];
  token_count: number;
  escalation_count: number;
  session_mode: SessionMode;
  waiting_for_recovery: boolean;
  last_checked_at: number;
  last_clear_at?: number;
  start_time: string;
  last_update: string;
  status: SessionStatus;
  completed_at?: string;  // Timestamp when marked completed (for cleanup)
  // Task hierarchy fields
  parent_session_id?: string;
  task_type: TaskType;
}

// Input for creating a new session state
export interface CreateSessionStateInput {
  session_id: string;
  user_id?: string;
  project_path: string;
  original_goal?: string;
  expected_scope?: string[];
  constraints?: string[];
  keywords?: string[];
  // Task hierarchy fields
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

// File reasoning change types
export type ChangeType = 'read' | 'write' | 'edit' | 'create' | 'delete';

// File-level reasoning with location anchoring
export interface FileReasoning {
  id: string;
  task_id?: string;
  file_path: string;
  anchor?: string;
  line_start?: number;
  line_end?: number;
  code_hash?: string;
  change_type?: ChangeType;
  reasoning: string;
  created_at: string;
}

// Input for creating file reasoning
export interface CreateFileReasoningInput {
  task_id?: string;
  file_path: string;
  anchor?: string;
  line_start?: number;
  line_end?: number;
  code_hash?: string;
  change_type?: ChangeType;
  reasoning: string;
}

let db: Database.Database | null = null;

// PERFORMANCE: Statement cache to avoid re-preparing frequently used queries
const statementCache = new Map<string, Database.Statement>();

/**
 * Get a cached prepared statement or create a new one.
 * PERFORMANCE: Avoids overhead of re-preparing the same SQL.
 */
function getCachedStatement(database: Database.Database, sql: string): Database.Statement {
  let stmt = statementCache.get(sql);
  if (!stmt) {
    stmt = database.prepare(sql);
    statementCache.set(sql, stmt);
  }
  return stmt;
}

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

  // Create steps table (action log for current session)
  db.exec(`
    CREATE TABLE IF NOT EXISTS steps (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      action_type TEXT NOT NULL CHECK(action_type IN ('edit', 'write', 'bash', 'read', 'glob', 'grep', 'task', 'other')),
      files JSON DEFAULT '[]',
      folders JSON DEFAULT '[]',
      command TEXT,
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
    // PERFORMANCE: Clear statement cache when database is closed
    statementCache.clear();
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
    created_at: new Date().toISOString()
  };

  const stmt = database.prepare(`
    INSERT INTO tasks (
      id, project_path, user, original_query, goal,
      reasoning_trace, files_touched, decisions, constraints,
      status, trigger_reason, linked_commit,
      parent_task_id, turn_number, tags, created_at
    ) VALUES (
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?, ?
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
    task.created_at
  );

  return task;
}

/**
 * Get tasks for a project
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
 * Get tasks that touched specific files.
 * SECURITY: Uses json_each for proper array handling and escaped LIKE patterns.
 */
// SECURITY: Maximum files per query to prevent SQL DoS
const MAX_FILES_PER_QUERY = 100;

export function getTasksByFiles(
  projectPath: string,
  files: string[],
  options: { status?: TaskStatus; limit?: number } = {}
): Task[] {
  const database = initDatabase();

  if (files.length === 0) {
    return [];
  }

  // SECURITY: Limit file count to prevent SQL DoS via massive query generation
  const limitedFiles = files.length > MAX_FILES_PER_QUERY
    ? files.slice(0, MAX_FILES_PER_QUERY)
    : files;

  // Use json_each for proper array iteration with escaped LIKE patterns
  const fileConditions = limitedFiles.map(() =>
    "EXISTS (SELECT 1 FROM json_each(files_touched) WHERE value LIKE ? ESCAPE '\\')"
  ).join(' OR ');

  let sql = `SELECT * FROM tasks WHERE project_path = ? AND (${fileConditions})`;
  // Escape LIKE special characters to prevent injection
  const params: (string | number)[] = [
    projectPath,
    ...limitedFiles.map(f => `%${escapeLikePattern(f)}%`)
  ];

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
 * Get a task by ID
 */
export function getTaskById(id: string): Task | null {
  const database = initDatabase();

  const stmt = database.prepare('SELECT * FROM tasks WHERE id = ?');
  const row = stmt.get(id) as Record<string, unknown> | undefined;

  return row ? rowToTask(row) : null;
}

/**
 * Update a task's status
 */
export function updateTaskStatus(id: string, status: TaskStatus): void {
  const database = initDatabase();

  const stmt = database.prepare('UPDATE tasks SET status = ? WHERE id = ?');
  stmt.run(status, id);
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
    created_at: row.created_at as string
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
    session_id: input.session_id,
    user_id: input.user_id,
    project_path: input.project_path,
    original_goal: input.original_goal,
    expected_scope: input.expected_scope || [],
    constraints: input.constraints || [],
    keywords: input.keywords || [],
    token_count: 0,
    escalation_count: 0,
    session_mode: 'normal',
    waiting_for_recovery: false,
    last_checked_at: 0,
    last_clear_at: undefined,
    start_time: now,
    last_update: now,
    status: 'active',
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
      parent_session_id, task_type
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    sessionState.task_type
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
 * Get active sessions for a project
 */
export function getActiveSessionsForProject(projectPath: string): SessionState[] {
  const database = initDatabase();

  const stmt = database.prepare(
    "SELECT * FROM session_states WHERE project_path = ? AND status = 'active' ORDER BY start_time DESC"
  );
  const rows = stmt.all(projectPath) as Record<string, unknown>[];

  return rows.map(rowToSessionState);
}

/**
 * Get child sessions (subtasks and parallel tasks) for a parent session
 */
export function getChildSessions(parentSessionId: string): SessionState[] {
  const database = initDatabase();

  const stmt = database.prepare(
    'SELECT * FROM session_states WHERE parent_session_id = ? ORDER BY start_time DESC'
  );
  const rows = stmt.all(parentSessionId) as Record<string, unknown>[];

  return rows.map(rowToSessionState);
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
 * Convert database row to SessionState object
 */
function rowToSessionState(row: Record<string, unknown>): SessionState {
  return {
    session_id: row.session_id as string,
    user_id: row.user_id as string | undefined,
    project_path: row.project_path as string,
    original_goal: row.original_goal as string | undefined,
    expected_scope: safeJsonParse<string[]>(row.expected_scope, []),
    constraints: safeJsonParse<string[]>(row.constraints, []),
    keywords: safeJsonParse<string[]>(row.keywords, []),
    token_count: (row.token_count as number) || 0,
    escalation_count: (row.escalation_count as number) || 0,
    session_mode: (row.session_mode as SessionMode) || 'normal',
    waiting_for_recovery: Boolean(row.waiting_for_recovery),
    last_checked_at: (row.last_checked_at as number) || 0,
    last_clear_at: row.last_clear_at as number | undefined,
    start_time: row.start_time as string,
    last_update: row.last_update as string,
    status: row.status as SessionStatus,
    completed_at: row.completed_at as string | undefined,
    parent_session_id: row.parent_session_id as string | undefined,
    task_type: (row.task_type as TaskType) || 'main',
  };
}

// ============================================
// FILE REASONING CRUD OPERATIONS
// ============================================

/**
 * Create a new file reasoning entry
 */
export function createFileReasoning(input: CreateFileReasoningInput): FileReasoning {
  const database = initDatabase();

  const fileReasoning: FileReasoning = {
    id: randomUUID(),
    task_id: input.task_id,
    file_path: input.file_path,
    anchor: input.anchor,
    line_start: input.line_start,
    line_end: input.line_end,
    code_hash: input.code_hash,
    change_type: input.change_type,
    reasoning: input.reasoning,
    created_at: new Date().toISOString()
  };

  const stmt = database.prepare(`
    INSERT INTO file_reasoning (
      id, task_id, file_path, anchor, line_start, line_end,
      code_hash, change_type, reasoning, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    fileReasoning.id,
    fileReasoning.task_id || null,
    fileReasoning.file_path,
    fileReasoning.anchor || null,
    fileReasoning.line_start || null,
    fileReasoning.line_end || null,
    fileReasoning.code_hash || null,
    fileReasoning.change_type || null,
    fileReasoning.reasoning,
    fileReasoning.created_at
  );

  return fileReasoning;
}

/**
 * Get file reasoning entries for a task
 */
export function getFileReasoningForTask(taskId: string): FileReasoning[] {
  const database = initDatabase();

  const stmt = database.prepare(
    'SELECT * FROM file_reasoning WHERE task_id = ? ORDER BY created_at DESC'
  );
  const rows = stmt.all(taskId) as Record<string, unknown>[];

  return rows.map(rowToFileReasoning);
}

/**
 * Get file reasoning entries by file path
 */
export function getFileReasoningByPath(filePath: string, limit = 10): FileReasoning[] {
  const database = initDatabase();

  const stmt = database.prepare(
    'SELECT * FROM file_reasoning WHERE file_path = ? ORDER BY created_at DESC LIMIT ?'
  );
  const rows = stmt.all(filePath, limit) as Record<string, unknown>[];

  return rows.map(rowToFileReasoning);
}

/**
 * Get file reasoning entries matching a pattern (for files in a project).
 * SECURITY: Uses escaped LIKE patterns to prevent injection.
 */
export function getFileReasoningByPathPattern(
  pathPattern: string,
  limit = 20
): FileReasoning[] {
  const database = initDatabase();

  // Escape LIKE special characters to prevent injection
  const escapedPattern = escapeLikePattern(pathPattern);
  const stmt = database.prepare(
    "SELECT * FROM file_reasoning WHERE file_path LIKE ? ESCAPE '\\' ORDER BY created_at DESC LIMIT ?"
  );
  const rows = stmt.all(`%${escapedPattern}%`, limit) as Record<string, unknown>[];

  return rows.map(rowToFileReasoning);
}

/**
 * Convert database row to FileReasoning object
 */
function rowToFileReasoning(row: Record<string, unknown>): FileReasoning {
  return {
    id: row.id as string,
    task_id: row.task_id as string | undefined,
    file_path: row.file_path as string,
    anchor: row.anchor as string | undefined,
    line_start: row.line_start as number | undefined,
    line_end: row.line_end as number | undefined,
    code_hash: row.code_hash as string | undefined,
    change_type: row.change_type as ChangeType | undefined,
    reasoning: row.reasoning as string,
    created_at: row.created_at as string
  };
}

/**
 * Get the database path
 */
export function getDatabasePath(): string {
  return DB_PATH;
}

// ============================================
// STEPS CRUD OPERATIONS
// ============================================

/**
 * Create a new step record
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

  // Update steps that don't have reasoning yet (NULL or empty)
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
 * Get relevant steps (key decisions and write/edit actions)
 * Reference: plan_proxy_local.md Section 2.2
 */
export function getRelevantSteps(sessionId: string, limit = 20): StepRecord[] {
  const database = initDatabase();

  const stmt = database.prepare(`
    SELECT * FROM steps
    WHERE session_id = ?
    AND (is_key_decision = 1 OR action_type IN ('edit', 'write', 'bash'))
    AND is_validated = 1
    ORDER BY timestamp DESC
    LIMIT ?
  `);
  const rows = stmt.all(sessionId, limit) as Record<string, unknown>[];

  return rows.map(rowToStep);
}

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

// ============================================
// DRIFT LOG CRUD OPERATIONS
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
 * Get drift log for a session
 */
export function getDriftLog(sessionId: string, limit = 50): DriftLogEntry[] {
  const database = initDatabase();

  const stmt = database.prepare(
    'SELECT * FROM drift_log WHERE session_id = ? ORDER BY timestamp DESC LIMIT ?'
  );
  const rows = stmt.all(sessionId, limit) as Record<string, unknown>[];

  return rows.map(rowToDriftLogEntry);
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
 * Update last checked timestamp
 */
export function updateLastChecked(sessionId: string): void {
  updateSessionState(sessionId, { last_checked_at: Date.now() });
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
 * Cleanup sessions completed more than 1 hour ago
 * Also deletes associated steps
 * Returns number of sessions cleaned up
 */
export function cleanupOldCompletedSessions(maxAgeMs: number = 3600000): number {
  const database = initDatabase();
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();

  // Get sessions to cleanup
  const oldSessions = database.prepare(`
    SELECT session_id FROM session_states
    WHERE status = 'completed' AND completed_at < ?
  `).all(cutoff) as Array<{ session_id: string }>;

  if (oldSessions.length === 0) {
    return 0;
  }

  // Delete steps for each session
  for (const session of oldSessions) {
    database.prepare('DELETE FROM steps WHERE session_id = ?').run(session.session_id);
    database.prepare('DELETE FROM session_states WHERE session_id = ?').run(session.session_id);
  }

  return oldSessions.length;
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
