import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// We'll test the store by setting GROV_DB_PATH env var
// But first we need to import the store functions

describe('Store', () => {
  let tempDir: string;
  let originalDbPath: string | undefined;

  beforeEach(() => {
    // Create a temporary directory for test database
    tempDir = mkdtempSync(join(tmpdir(), 'grov-test-'));
    originalDbPath = process.env.GROV_DB_PATH;
    process.env.GROV_DB_PATH = join(tempDir, 'test.db');
  });

  afterEach(() => {
    // Restore original env and clean up
    if (originalDbPath) {
      process.env.GROV_DB_PATH = originalDbPath;
    } else {
      delete process.env.GROV_DB_PATH;
    }

    // Clean up temp directory
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('Database initialization', () => {
    it('should create database directory if it does not exist', async () => {
      // Import dynamically to ensure fresh module state
      const { initDatabase, closeDatabase, getDatabasePath } = await import('../src/lib/store.js');

      const db = initDatabase();
      expect(db).toBeDefined();

      const dbPath = getDatabasePath();
      expect(existsSync(dbPath)).toBe(true);

      closeDatabase();
    });
  });

  describe('Task operations', () => {
    it('should create and retrieve a task', async () => {
      const { initDatabase, createTask, getTaskById, closeDatabase } = await import('../src/lib/store.js');

      initDatabase();

      const task = createTask({
        project_path: '/test/project',
        original_query: 'Fix the bug',
        goal: 'Fix authentication bug',
        reasoning_trace: ['Investigated auth flow', 'Found issue in token refresh'],
        files_touched: ['src/auth.ts', 'src/token.ts'],
        status: 'complete',
        tags: ['auth', 'bug']
      });

      expect(task.id).toBeDefined();
      expect(task.original_query).toBe('Fix the bug');
      expect(task.status).toBe('complete');
      expect(task.reasoning_trace).toHaveLength(2);
      expect(task.files_touched).toHaveLength(2);
      expect(task.tags).toContain('auth');

      const retrieved = getTaskById(task.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved?.id).toBe(task.id);
      expect(retrieved?.goal).toBe('Fix authentication bug');

      closeDatabase();
    });

    it('should filter tasks by project path', async () => {
      const { initDatabase, createTask, getTasksForProject, closeDatabase } = await import('../src/lib/store.js');

      initDatabase();

      // Use unique paths to avoid conflicts
      const uniqueA = `/project/a-${Date.now()}`;
      const uniqueB = `/project/b-${Date.now()}`;

      createTask({
        project_path: uniqueA,
        original_query: 'Task A',
        status: 'complete',
      });

      createTask({
        project_path: uniqueB,
        original_query: 'Task B',
        status: 'complete',
      });

      const tasksA = getTasksForProject(uniqueA);
      expect(tasksA).toHaveLength(1);
      expect(tasksA[0].original_query).toBe('Task A');

      const tasksB = getTasksForProject(uniqueB);
      expect(tasksB).toHaveLength(1);
      expect(tasksB[0].original_query).toBe('Task B');

      closeDatabase();
    });

    it('should return empty array for non-existent project', async () => {
      const { initDatabase, getTasksForProject, closeDatabase } = await import('../src/lib/store.js');

      initDatabase();

      const tasks = getTasksForProject('/non/existent/project');
      expect(tasks).toHaveLength(0);

      closeDatabase();
    });

    it('should handle special characters in project paths', async () => {
      const { initDatabase, createTask, getTasksForProject, closeDatabase } = await import('../src/lib/store.js');

      initDatabase();

      // Use unique path with special characters
      const specialPath = `/Users/dev/my-project_with.special/chars-${Date.now()}`;

      createTask({
        project_path: specialPath,
        original_query: 'Special task',
        status: 'complete',
      });

      const tasks = getTasksForProject(specialPath);
      expect(tasks).toHaveLength(1);

      closeDatabase();
    });
  });

  describe('Task count', () => {
    it('should return correct task count delta after adding tasks', async () => {
      const { initDatabase, createTask, getTaskCount, closeDatabase } = await import('../src/lib/store.js');

      initDatabase();

      // Use a unique project path to avoid conflicts with other tests
      const uniqueProject = `/test/project/count-${Date.now()}`;

      const initialCount = getTaskCount(uniqueProject);
      expect(initialCount).toBe(0); // New unique project should have 0 tasks

      createTask({
        project_path: uniqueProject,
        original_query: 'Task 1',
        status: 'complete',
      });

      createTask({
        project_path: uniqueProject,
        original_query: 'Task 2',
        status: 'partial',
      });

      expect(getTaskCount(uniqueProject)).toBe(initialCount + 2);

      closeDatabase();
    });
  });

  describe('Task status update', () => {
    it('should update task status', async () => {
      const { initDatabase, createTask, getTaskById, updateTaskStatus, closeDatabase } = await import('../src/lib/store.js');

      initDatabase();

      const task = createTask({
        project_path: '/test/project',
        original_query: 'Task',
        status: 'partial',
      });

      expect(getTaskById(task.id)?.status).toBe('partial');

      updateTaskStatus(task.id, 'complete');

      expect(getTaskById(task.id)?.status).toBe('complete');

      closeDatabase();
    });
  });
});
