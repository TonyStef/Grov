// SQLite store for task reasoning at ~/.grov/memory.db

import Database from 'better-sqlite3';
import { existsSync, mkdirSync, chmodSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import type { ClaudeAction } from './session-parser.js';

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
  // Drift detection fields (set at first prompt)
  expected_scope: string[];
  constraints: string[];
  success_criteria: string[];
  keywords: string[];
  // Drift tracking fields (updated per prompt)
  last_drift_score?: number;
  escalation_count: number;
  pending_recovery_plan?: RecoveryPlan;
  drift_history: DriftEvent[];
  // Action tracking for JSONL parsing
  last_checked_at: number;
}

// Recovery plan for drift correction
export interface RecoveryPlan {
  steps: Array<{
    file?: string;
    action: string;
  }>;
}

// Drift event tracked per prompt
export interface DriftEvent {
  timestamp: string;
  score: number;
  level: string;
  prompt_summary: string;
}

// Input for creating a new session state
export interface CreateSessionStateInput {
  session_id: string;
  user_id?: string;
  project_path: string;
  original_goal?: string;
  // Drift detection fields (optional, set from extractIntent)
  expected_scope?: string[];
  constraints?: string[];
  success_criteria?: string[];
  keywords?: string[];
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

  // Ensure .grov directory exists with secure permissions
  if (!existsSync(GROV_DIR)) {
    mkdirSync(GROV_DIR, { recursive: true, mode: 0o700 });
  }

  db = new Database(DB_PATH);

  // Set secure file permissions on the database
  try {
    chmodSync(DB_PATH, 0o600);
  } catch {
    // Ignore if chmod fails (e.g., on Windows)
  }

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

  // Migration: Add drift detection columns to session_states (safe to run multiple times)
  const columns = db.pragma('table_info(session_states)') as Array<{ name: string }>;
  const existingColumns = new Set(columns.map(c => c.name));

  if (!existingColumns.has('expected_scope')) {
    db.exec(`ALTER TABLE session_states ADD COLUMN expected_scope JSON DEFAULT '[]'`);
  }
  if (!existingColumns.has('constraints')) {
    db.exec(`ALTER TABLE session_states ADD COLUMN constraints JSON DEFAULT '[]'`);
  }
  if (!existingColumns.has('success_criteria')) {
    db.exec(`ALTER TABLE session_states ADD COLUMN success_criteria JSON DEFAULT '[]'`);
  }
  if (!existingColumns.has('keywords')) {
    db.exec(`ALTER TABLE session_states ADD COLUMN keywords JSON DEFAULT '[]'`);
  }
  if (!existingColumns.has('last_drift_score')) {
    db.exec(`ALTER TABLE session_states ADD COLUMN last_drift_score INTEGER`);
  }
  if (!existingColumns.has('escalation_count')) {
    db.exec(`ALTER TABLE session_states ADD COLUMN escalation_count INTEGER DEFAULT 0`);
  }
  if (!existingColumns.has('pending_recovery_plan')) {
    db.exec(`ALTER TABLE session_states ADD COLUMN pending_recovery_plan JSON`);
  }
  if (!existingColumns.has('drift_history')) {
    db.exec(`ALTER TABLE session_states ADD COLUMN drift_history JSON DEFAULT '[]'`);
  }
  if (!existingColumns.has('last_checked_at')) {
    db.exec(`ALTER TABLE session_states ADD COLUMN last_checked_at INTEGER DEFAULT 0`);
  }

  // Create steps table (Claude's actions for drift detection)
  db.exec(`
    CREATE TABLE IF NOT EXISTS steps (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      action_type TEXT NOT NULL,
      files JSON DEFAULT '[]',
      folders JSON DEFAULT '[]',
      command TEXT,
      reasoning TEXT,
      drift_score INTEGER,
      is_key_decision BOOLEAN DEFAULT 0,
      keywords JSON DEFAULT '[]',
      timestamp INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES session_states(session_id)
    );
    CREATE INDEX IF NOT EXISTS idx_steps_session ON steps(session_id);
    CREATE INDEX IF NOT EXISTS idx_steps_timestamp ON steps(timestamp);
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
 * Get tasks that touched specific files.
 * SECURITY: Uses json_each for proper array handling and escaped LIKE patterns.
 */
export function getTasksByFiles(
  projectPath: string,
  files: string[],
  options: { status?: TaskStatus; limit?: number } = {}
): Task[] {
  const database = initDatabase();

  if (files.length === 0) {
    return [];
  }

  // Use json_each for proper array iteration with escaped LIKE patterns
  const fileConditions = files.map(() =>
    "EXISTS (SELECT 1 FROM json_each(files_touched) WHERE value LIKE ? ESCAPE '\\')"
  ).join(' OR ');

  let sql = `SELECT * FROM tasks WHERE project_path = ? AND (${fileConditions})`;
  // Escape LIKE special characters to prevent injection
  const params: (string | number)[] = [
    projectPath,
    ...files.map(f => `%${escapeLikePattern(f)}%`)
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
    status: row.status as TaskStatus,
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
    status: 'active',
    // Drift detection fields
    expected_scope: input.expected_scope || [],
    constraints: input.constraints || [],
    success_criteria: input.success_criteria || [],
    keywords: input.keywords || [],
    // Drift tracking fields
    last_drift_score: undefined,
    escalation_count: 0,
    pending_recovery_plan: undefined,
    drift_history: [],
    // Action tracking
    last_checked_at: 0
  };

  const stmt = database.prepare(`
    INSERT INTO session_states (
      session_id, user_id, project_path, original_goal,
      actions_taken, files_explored, current_intent, drift_warnings,
      start_time, last_update, status,
      expected_scope, constraints, success_criteria, keywords,
      last_drift_score, escalation_count, pending_recovery_plan, drift_history,
      last_checked_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    sessionState.status,
    JSON.stringify(sessionState.expected_scope),
    JSON.stringify(sessionState.constraints),
    JSON.stringify(sessionState.success_criteria),
    JSON.stringify(sessionState.keywords),
    sessionState.last_drift_score || null,
    sessionState.escalation_count,
    sessionState.pending_recovery_plan ? JSON.stringify(sessionState.pending_recovery_plan) : null,
    JSON.stringify(sessionState.drift_history),
    sessionState.last_checked_at
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
    actions_taken: safeJsonParse<string[]>(row.actions_taken, []),
    files_explored: safeJsonParse<string[]>(row.files_explored, []),
    current_intent: row.current_intent as string | undefined,
    drift_warnings: safeJsonParse<string[]>(row.drift_warnings, []),
    start_time: row.start_time as string,
    last_update: row.last_update as string,
    status: row.status as SessionStatus,
    // Drift detection fields
    expected_scope: safeJsonParse<string[]>(row.expected_scope, []),
    constraints: safeJsonParse<string[]>(row.constraints, []),
    success_criteria: safeJsonParse<string[]>(row.success_criteria, []),
    keywords: safeJsonParse<string[]>(row.keywords, []),
    // Drift tracking fields
    last_drift_score: row.last_drift_score as number | undefined,
    escalation_count: (row.escalation_count as number) || 0,
    pending_recovery_plan: safeJsonParse<RecoveryPlan | undefined>(row.pending_recovery_plan, undefined),
    drift_history: safeJsonParse<DriftEvent[]>(row.drift_history, []),
    // Action tracking
    last_checked_at: (row.last_checked_at as number) || 0
  };
}

// ============================================
// DRIFT DETECTION OPERATIONS
// ============================================

/**
 * Correction level types for drift detection
 */
export type CorrectionLevel = 'nudge' | 'correct' | 'intervene' | 'halt';

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
  const newHistory = [...session.drift_history, driftEvent];

  // Add to drift_warnings if correction was given
  const newWarnings = correctionLevel
    ? [...session.drift_warnings, `[${now}] ${correctionLevel}: score ${driftScore}`]
    : session.drift_warnings;

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
 * Check if a session should be flagged for review
 * Returns true if: status=drifted OR warnings>=3 OR avg_score<6
 */
export function shouldFlagForReview(sessionId: string): boolean {
  const session = getSessionState(sessionId);
  if (!session) return false;

  // Check number of warnings
  if (session.drift_warnings.length >= 3) {
    return true;
  }

  // Check drift history for average score
  if (session.drift_history.length >= 2) {
    const totalScore = session.drift_history.reduce((sum, e) => sum + e.score, 0);
    const avgScore = totalScore / session.drift_history.length;
    if (avgScore < 6) {
      return true;
    }
  }

  // Check if any HALT level drift occurred
  if (session.drift_history.some(e => e.level === 'halt')) {
    return true;
  }

  // Check current escalation level
  if (session.escalation_count >= 2) {
    return true;
  }

  return false;
}

/**
 * Get drift summary for a session (used by capture)
 */
export function getDriftSummary(sessionId: string): {
  totalEvents: number;
  resolved: boolean;
  finalScore: number | null;
  hadHalt: boolean;
} {
  const session = getSessionState(sessionId);
  if (!session || session.drift_history.length === 0) {
    return { totalEvents: 0, resolved: true, finalScore: null, hadHalt: false };
  }

  const lastEvent = session.drift_history[session.drift_history.length - 1];
  return {
    totalEvents: session.drift_history.length,
    resolved: lastEvent.score >= 8,
    finalScore: lastEvent.score,
    hadHalt: session.drift_history.some(e => e.level === 'halt')
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
// STEPS CRUD (Claude's actions for drift detection)
// ============================================

/**
 * Step record - a single Claude action stored in DB
 */
export interface StepRecord {
  id: string;
  session_id: string;
  action_type: string;
  files: string[];
  folders: string[];
  command?: string;
  reasoning?: string;
  drift_score: number;
  is_key_decision: boolean;
  keywords: string[];
  timestamp: number;
}

/**
 * Save a Claude action as a step
 */
export function saveStep(
  sessionId: string,
  action: ClaudeAction,
  driftScore: number,
  isKeyDecision: boolean = false,
  keywords: string[] = []
): void {
  const database = initDatabase();

  // Extract folders from files
  const folders = [...new Set(
    action.files
      .map(f => f.split('/').slice(0, -1).join('/'))
      .filter(f => f.length > 0)
  )];

  database.prepare(`
    INSERT INTO steps (id, session_id, action_type, files, folders, command, drift_score, is_key_decision, keywords, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    randomUUID(),
    sessionId,
    action.type,
    JSON.stringify(action.files),
    JSON.stringify(folders),
    action.command || null,
    driftScore,
    isKeyDecision ? 1 : 0,
    JSON.stringify(keywords),
    action.timestamp
  );
}

/**
 * Get recent steps for a session (most recent first)
 */
export function getRecentSteps(sessionId: string, limit: number = 10): StepRecord[] {
  const database = initDatabase();
  const rows = database.prepare(`
    SELECT * FROM steps WHERE session_id = ? ORDER BY timestamp DESC LIMIT ?
  `).all(sessionId, limit) as Record<string, unknown>[];
  return rows.map(rowToStepRecord);
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
// 4-QUERY RETRIEVAL (from deep_dive.md)
// ============================================

/**
 * Get steps that touched specific files
 */
export function getStepsByFiles(sessionId: string, files: string[], limit: number = 5): StepRecord[] {
  if (files.length === 0) return [];

  const database = initDatabase();
  const placeholders = files.map(() => `files LIKE ?`).join(' OR ');
  const patterns = files.map(f => `%"${escapeLikePattern(f)}"%`);

  const rows = database.prepare(`
    SELECT * FROM steps
    WHERE session_id = ? AND drift_score >= 5 AND (${placeholders})
    ORDER BY timestamp DESC LIMIT ?
  `).all(sessionId, ...patterns, limit) as Record<string, unknown>[];

  return rows.map(rowToStepRecord);
}

/**
 * Get steps that touched specific folders
 */
export function getStepsByFolders(sessionId: string, folders: string[], limit: number = 5): StepRecord[] {
  if (folders.length === 0) return [];

  const database = initDatabase();
  const placeholders = folders.map(() => `folders LIKE ?`).join(' OR ');
  const patterns = folders.map(f => `%"${escapeLikePattern(f)}"%`);

  const rows = database.prepare(`
    SELECT * FROM steps
    WHERE session_id = ? AND drift_score >= 5 AND (${placeholders})
    ORDER BY timestamp DESC LIMIT ?
  `).all(sessionId, ...patterns, limit) as Record<string, unknown>[];

  return rows.map(rowToStepRecord);
}

/**
 * Get steps matching keywords
 */
export function getStepsByKeywords(sessionId: string, keywords: string[], limit: number = 5): StepRecord[] {
  if (keywords.length === 0) return [];

  const database = initDatabase();
  const conditions = keywords.map(() => `keywords LIKE ?`).join(' OR ');
  const patterns = keywords.map(k => `%"${escapeLikePattern(k)}"%`);

  const rows = database.prepare(`
    SELECT * FROM steps
    WHERE session_id = ? AND drift_score >= 5 AND (${conditions})
    ORDER BY timestamp DESC LIMIT ?
  `).all(sessionId, ...patterns, limit) as Record<string, unknown>[];

  return rows.map(rowToStepRecord);
}

/**
 * Get key decision steps
 */
export function getKeyDecisionSteps(sessionId: string, limit: number = 5): StepRecord[] {
  const database = initDatabase();
  const rows = database.prepare(`
    SELECT * FROM steps
    WHERE session_id = ? AND is_key_decision = 1
    ORDER BY timestamp DESC LIMIT ?
  `).all(sessionId, limit) as Record<string, unknown>[];

  return rows.map(rowToStepRecord);
}

/**
 * Combined retrieval: runs all 4 queries and deduplicates
 * Priority: key decisions > files > folders > keywords
 */
export function getRelevantSteps(
  sessionId: string,
  currentFiles: string[],
  currentFolders: string[],
  keywords: string[],
  limit: number = 10
): StepRecord[] {
  const byFiles = getStepsByFiles(sessionId, currentFiles, 5);
  const byFolders = getStepsByFolders(sessionId, currentFolders, 5);
  const byKeywords = getStepsByKeywords(sessionId, keywords, 5);
  const keyDecisions = getKeyDecisionSteps(sessionId, 5);

  const seen = new Set<string>();
  const results: StepRecord[] = [];

  // Priority order: key decisions > files > folders > keywords
  for (const step of [...keyDecisions, ...byFiles, ...byFolders, ...byKeywords]) {
    if (!seen.has(step.id)) {
      seen.add(step.id);
      results.push(step);
      if (results.length >= limit) break;
    }
  }

  return results;
}

/**
 * Convert database row to StepRecord
 */
function rowToStepRecord(row: Record<string, unknown>): StepRecord {
  return {
    id: row.id as string,
    session_id: row.session_id as string,
    action_type: row.action_type as string,
    files: safeJsonParse<string[]>(row.files, []),
    folders: safeJsonParse<string[]>(row.folders, []),
    command: row.command as string | undefined,
    reasoning: row.reasoning as string | undefined,
    drift_score: row.drift_score as number,
    is_key_decision: row.is_key_decision === 1,
    keywords: safeJsonParse<string[]>(row.keywords, []),
    timestamp: row.timestamp as number
  };
}
