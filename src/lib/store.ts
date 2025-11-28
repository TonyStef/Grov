// SQLite store for task reasoning at ~/.grov/memory.db

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';

const GROV_DIR = join(homedir(), '.grov');
const DB_PATH = join(GROV_DIR, 'memory.db');

// Task status types
export type TaskStatus = 'complete' | 'question' | 'partial' | 'abandoned';

// Task data structure
export interface Task {
  id: string;
  project_path: string;
  user?: string;
  original_query: string;
  goal?: string;
  reasoning_trace: string[];      // JSON array
  files_touched: string[];        // JSON array
  status: TaskStatus;
  linked_commit?: string;
  parent_task_id?: string;
  turn_number?: number;
  tags: string[];                 // JSON array
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
  status: TaskStatus;
  linked_commit?: string;
  parent_task_id?: string;
  turn_number?: number;
  tags?: string[];
}

// Session state status types
export type SessionStatus = 'active' | 'completed' | 'abandoned';

// Session state for per-session tracking (temporary)
export interface SessionState {
  session_id: string;
  user_id?: string;
  project_path: string;
  original_goal?: string;
  actions_taken: string[];
  files_explored: string[];
  current_intent?: string;
  drift_warnings: string[];
  start_time: string;
  last_update: string;
  status: SessionStatus;
}

// Input for creating a new session state
export interface CreateSessionStateInput {
  session_id: string;
  user_id?: string;
  project_path: string;
  original_goal?: string;
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

/**
 * Initialize the database connection and create tables
 */
export function initDatabase(): Database.Database {
  if (db) return db;

  // Ensure .grov directory exists
  if (!existsSync(GROV_DIR)) {
    mkdirSync(GROV_DIR, { recursive: true });
  }

  db = new Database(DB_PATH);

  // Create tasks table
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      project_path TEXT NOT NULL,
      user TEXT,
      original_query TEXT NOT NULL,
      goal TEXT,
      reasoning_trace JSON DEFAULT '[]',
      files_touched JSON DEFAULT '[]',
      status TEXT NOT NULL CHECK(status IN ('complete', 'question', 'partial', 'abandoned')),
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

  // Create session_states table (temporary per-session tracking)
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_states (
      session_id TEXT PRIMARY KEY,
      user_id TEXT,
      project_path TEXT NOT NULL,
      original_goal TEXT,
      actions_taken JSON DEFAULT '[]',
      files_explored JSON DEFAULT '[]',
      current_intent TEXT,
      drift_warnings JSON DEFAULT '[]',
      start_time TEXT NOT NULL,
      last_update TEXT NOT NULL,
      status TEXT DEFAULT 'active' CHECK(status IN ('active', 'completed', 'abandoned'))
    );

    CREATE INDEX IF NOT EXISTS idx_session_project ON session_states(project_path);
    CREATE INDEX IF NOT EXISTS idx_session_status ON session_states(status);
  `);

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
    status: input.status,
    linked_commit: input.linked_commit,
    parent_task_id: input.parent_task_id,
    turn_number: input.turn_number,
    tags: input.tags || [],
    created_at: new Date().toISOString()
  };

  const stmt = database.prepare(`
    INSERT INTO tasks (
      id, project_path, user, original_query, goal,
      reasoning_trace, files_touched, status, linked_commit,
      parent_task_id, turn_number, tags, created_at
    ) VALUES (
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
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
    task.status,
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
 * Get tasks that touched specific files
 */
export function getTasksByFiles(
  projectPath: string,
  files: string[],
  options: { status?: TaskStatus; limit?: number } = {}
): Task[] {
  const database = initDatabase();

  // SQLite JSON search - look for any file match
  const fileConditions = files.map(() => "json_extract(files_touched, '$') LIKE ?").join(' OR ');

  let sql = `SELECT * FROM tasks WHERE project_path = ? AND (${fileConditions})`;
  const params: (string | number)[] = [projectPath, ...files.map(f => `%${f}%`)];

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
  const row = stmt.get(projectPath) as { count: number };

  return row.count;
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
    reasoning_trace: JSON.parse(row.reasoning_trace as string || '[]'),
    files_touched: JSON.parse(row.files_touched as string || '[]'),
    status: row.status as TaskStatus,
    linked_commit: row.linked_commit as string | undefined,
    parent_task_id: row.parent_task_id as string | undefined,
    turn_number: row.turn_number as number | undefined,
    tags: JSON.parse(row.tags as string || '[]'),
    created_at: row.created_at as string
  };
}

// ============================================
// SESSION STATE CRUD OPERATIONS
// ============================================

/**
 * Create a new session state
 */
export function createSessionState(input: CreateSessionStateInput): SessionState {
  const database = initDatabase();
  const now = new Date().toISOString();

  const sessionState: SessionState = {
    session_id: input.session_id,
    user_id: input.user_id,
    project_path: input.project_path,
    original_goal: input.original_goal,
    actions_taken: [],
    files_explored: [],
    current_intent: undefined,
    drift_warnings: [],
    start_time: now,
    last_update: now,
    status: 'active'
  };

  const stmt = database.prepare(`
    INSERT INTO session_states (
      session_id, user_id, project_path, original_goal,
      actions_taken, files_explored, current_intent, drift_warnings,
      start_time, last_update, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    sessionState.session_id,
    sessionState.user_id || null,
    sessionState.project_path,
    sessionState.original_goal || null,
    JSON.stringify(sessionState.actions_taken),
    JSON.stringify(sessionState.files_explored),
    sessionState.current_intent || null,
    JSON.stringify(sessionState.drift_warnings),
    sessionState.start_time,
    sessionState.last_update,
    sessionState.status
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
 * Update a session state
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
  if (updates.actions_taken !== undefined) {
    setClauses.push('actions_taken = ?');
    params.push(JSON.stringify(updates.actions_taken));
  }
  if (updates.files_explored !== undefined) {
    setClauses.push('files_explored = ?');
    params.push(JSON.stringify(updates.files_explored));
  }
  if (updates.current_intent !== undefined) {
    setClauses.push('current_intent = ?');
    params.push(updates.current_intent || null);
  }
  if (updates.drift_warnings !== undefined) {
    setClauses.push('drift_warnings = ?');
    params.push(JSON.stringify(updates.drift_warnings));
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
  database.prepare(sql).run(...params);
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
 * Convert database row to SessionState object
 */
function rowToSessionState(row: Record<string, unknown>): SessionState {
  return {
    session_id: row.session_id as string,
    user_id: row.user_id as string | undefined,
    project_path: row.project_path as string,
    original_goal: row.original_goal as string | undefined,
    actions_taken: JSON.parse(row.actions_taken as string || '[]'),
    files_explored: JSON.parse(row.files_explored as string || '[]'),
    current_intent: row.current_intent as string | undefined,
    drift_warnings: JSON.parse(row.drift_warnings as string || '[]'),
    start_time: row.start_time as string,
    last_update: row.last_update as string,
    status: row.status as SessionStatus
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
 * Get file reasoning entries matching a pattern (for files in a project)
 */
export function getFileReasoningByPathPattern(
  pathPattern: string,
  limit = 20
): FileReasoning[] {
  const database = initDatabase();

  const stmt = database.prepare(
    'SELECT * FROM file_reasoning WHERE file_path LIKE ? ORDER BY created_at DESC LIMIT ?'
  );
  const rows = stmt.all(`%${pathPattern}%`, limit) as Record<string, unknown>[];

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
