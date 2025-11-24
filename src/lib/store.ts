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

/**
 * Get the database path
 */
export function getDatabasePath(): string {
  return DB_PATH;
}
