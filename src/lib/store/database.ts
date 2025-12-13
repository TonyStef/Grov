// Database connection, schema, and utilities

import Database from 'better-sqlite3';
import { existsSync, mkdirSync, chmodSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const GROV_DIR = join(homedir(), '.grov');
const DB_PATH = join(GROV_DIR, 'memory.db');

let db: Database.Database | null = null;

/**
 * Escape LIKE pattern special characters to prevent SQL injection.
 * SECURITY: Prevents wildcard injection in LIKE queries.
 */
function escapeLikePattern(str: string): string {
  return str.replace(/[%_\\]/g, '\\$&');
}

/**
 * Safely parse JSON with fallback to provided default.
 */
export function safeJsonParse<T>(value: unknown, fallback: T): T {
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
 * Get the database path
 */
export function getDatabasePath(): string {
  return DB_PATH;
}

/**
 * Get initialized database connection.
 * Internal helper for other store modules.
 */
export function getDb(): Database.Database {
  return initDatabase();
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
    CREATE INDEX IF NOT EXISTS idx_file_path_created ON file_reasoning(file_path, created_at DESC);
  `);

  // Migration: Add drift detection columns to session_states
  const columns = db.pragma('table_info(session_states)') as Array<{ name: string }>;
  const existingColumns = new Set(columns.map(c => c.name));

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
