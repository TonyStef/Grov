// MCP SQLite Store
// Stores pending tasks locally for async sync to cloud
// Uses separate mcp_tasks table in ~/.grov/memory.db

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';

const GROV_DIR = join(homedir(), '.grov');
const DB_PATH = join(GROV_DIR, 'memory.db');

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

export interface McpTask {
  id: string;
  project_path: string;
  mode: 'agent' | 'planning' | 'ask';
  goal: string;
  original_query: string;
  summary: string;
  reasoning_trace: string;  // JSON array
  decisions: string;        // JSON array
  files_touched: string;    // JSON array
  created_at: string;
  match_id: string | null;
  sync_status: 'pending' | 'syncing' | 'synced' | 'error';
  synced_at: string | null;
  sync_error: string | null;
}

export interface McpTaskInput {
  project_path: string;
  mode: 'agent' | 'planning' | 'ask';
  goal: string;
  original_query: string;
  summary: string;
  reasoning_trace: Array<{ conclusion: string; insight: string }>;
  decisions: Array<{ choice: string; reason: string }>;
  files_touched: string[];
}

// ─────────────────────────────────────────────────────────────
// Database Connection
// ─────────────────────────────────────────────────────────────

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (db) return db;

  // Ensure directory exists
  if (!existsSync(GROV_DIR)) {
    mkdirSync(GROV_DIR, { recursive: true, mode: 0o700 });
  }

  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  // Create mcp_tasks table if not exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS mcp_tasks (
      id TEXT PRIMARY KEY,
      project_path TEXT NOT NULL,
      mode TEXT NOT NULL,
      goal TEXT NOT NULL,
      original_query TEXT NOT NULL,
      summary TEXT NOT NULL,
      reasoning_trace TEXT NOT NULL,
      decisions TEXT NOT NULL,
      files_touched TEXT NOT NULL,
      created_at TEXT NOT NULL,
      match_id TEXT,
      sync_status TEXT NOT NULL DEFAULT 'pending',
      synced_at TEXT,
      sync_error TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_mcp_tasks_project
    ON mcp_tasks(project_path);

    CREATE INDEX IF NOT EXISTS idx_mcp_tasks_sync_status
    ON mcp_tasks(sync_status);
  `);

  return db;
}

// ─────────────────────────────────────────────────────────────
// CRUD Operations
// ─────────────────────────────────────────────────────────────

/**
 * Save a new task locally
 * Returns the task ID
 */
export function createTask(input: McpTaskInput): string {
  const database = getDb();
  const id = randomUUID();
  const now = new Date().toISOString();

  const stmt = database.prepare(`
    INSERT INTO mcp_tasks (
      id, project_path, mode, goal, original_query, summary,
      reasoning_trace, decisions, files_touched, created_at, sync_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
  `);

  stmt.run(
    id,
    input.project_path,
    input.mode,
    input.goal,
    input.original_query,
    input.summary,
    JSON.stringify(input.reasoning_trace),
    JSON.stringify(input.decisions),
    JSON.stringify(input.files_touched),
    now
  );

  return id;
}

/**
 * Get a task by ID
 */
export function getTask(id: string): McpTask | null {
  const database = getDb();
  const stmt = database.prepare('SELECT * FROM mcp_tasks WHERE id = ?');
  return stmt.get(id) as McpTask | null;
}

/**
 * Get pending tasks for sync
 */
export function getPendingTasks(limit = 10): McpTask[] {
  const database = getDb();
  const stmt = database.prepare(`
    SELECT * FROM mcp_tasks
    WHERE sync_status = 'pending'
    ORDER BY created_at ASC
    LIMIT ?
  `);
  return stmt.all(limit) as McpTask[];
}

/**
 * Mark task as syncing
 */
export function markSyncing(id: string): void {
  const database = getDb();
  const stmt = database.prepare(`
    UPDATE mcp_tasks
    SET sync_status = 'syncing'
    WHERE id = ?
  `);
  stmt.run(id);
}

/**
 * Mark task as synced successfully
 */
export function markSynced(id: string, matchId?: string): void {
  const database = getDb();
  const now = new Date().toISOString();
  const stmt = database.prepare(`
    UPDATE mcp_tasks
    SET sync_status = 'synced', synced_at = ?, match_id = ?
    WHERE id = ?
  `);
  stmt.run(now, matchId || null, id);
}

/**
 * Mark task as sync error
 */
export function markError(id: string, error: string): void {
  const database = getDb();
  const stmt = database.prepare(`
    UPDATE mcp_tasks
    SET sync_status = 'error', sync_error = ?
    WHERE id = ?
  `);
  stmt.run(error, id);
}

/**
 * Update task with match decision
 * Called after grov_decide_update
 */
export function updateWithDecision(
  id: string,
  decision: 'update' | 'skip',
  matchId?: string
): void {
  const database = getDb();
  const stmt = database.prepare(`
    UPDATE mcp_tasks
    SET match_id = ?, sync_status = 'pending'
    WHERE id = ?
  `);
  stmt.run(matchId || null, id);
}

/**
 * Get recent tasks for a project
 */
export function getRecentTasks(projectPath: string, limit = 10): McpTask[] {
  const database = getDb();
  const stmt = database.prepare(`
    SELECT * FROM mcp_tasks
    WHERE project_path = ?
    ORDER BY created_at DESC
    LIMIT ?
  `);
  return stmt.all(projectPath, limit) as McpTask[];
}
