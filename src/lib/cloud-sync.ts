// Cloud sync logic - Upload memories from local database to API
// Handles batching, retries, and conversion from Task to Memory format

import type { CreateMemoryInput, MemorySyncResponse } from '@grov/shared';
import { getSyncStatus, getAccessToken } from './credentials.js';
import { syncMemories, sleep } from './api-client.js';
import type { Task } from './store.js';

// Sync configuration
const SYNC_CONFIG = {
  batchSize: 10,       // Number of memories per batch
  retryAttempts: 3,    // Number of retry attempts per batch
  retryDelay: 1000,    // Base delay between retries (ms)
};

/**
 * Convert local Task to CreateMemoryInput for API
 */
export function taskToMemory(task: Task): CreateMemoryInput {
  return {
    project_path: task.project_path,
    original_query: task.original_query,
    goal: task.goal,
    reasoning_trace: task.reasoning_trace,
    files_touched: task.files_touched,
    decisions: task.decisions,
    constraints: task.constraints,
    tags: task.tags,
    status: task.status,
    linked_commit: task.linked_commit,
  };
}

/**
 * Check if sync is enabled and configured
 */
export function isSyncEnabled(): boolean {
  const status = getSyncStatus();
  return status?.enabled === true && !!status.teamId;
}

/**
 * Get the configured team ID for sync
 */
export function getSyncTeamId(): string | null {
  const status = getSyncStatus();
  return status?.teamId || null;
}

/**
 * Sync a single task to the cloud
 * Called when a task is completed
 */
export async function syncTask(task: Task): Promise<boolean> {
  if (!isSyncEnabled()) {
    return false;
  }

  const teamId = getSyncTeamId();
  if (!teamId) {
    return false;
  }

  const token = await getAccessToken();
  if (!token) {
    return false;
  }

  try {
    const memory = taskToMemory(task);
    const result = await syncMemories(teamId, { memories: [memory] });
    return result.synced === 1;
  } catch {
    return false;
  }
}

/**
 * Sync multiple tasks with batching and retry
 */
export async function syncTasks(tasks: Task[]): Promise<{
  synced: number;
  failed: number;
  errors: string[];
}> {
  if (!isSyncEnabled()) {
    return {
      synced: 0,
      failed: tasks.length,
      errors: ['Sync is not enabled. Run "grov sync --enable --team <team-id>" first.'],
    };
  }

  const teamId = getSyncTeamId();
  if (!teamId) {
    return {
      synced: 0,
      failed: tasks.length,
      errors: ['No team configured. Run "grov sync --enable --team <team-id>" first.'],
    };
  }

  const token = await getAccessToken();
  if (!token) {
    return {
      synced: 0,
      failed: tasks.length,
      errors: ['Not authenticated. Run "grov login" first.'],
    };
  }

  // Convert tasks to memories
  const memories = tasks.map(taskToMemory);

  // Batch and sync
  const batches: CreateMemoryInput[][] = [];
  for (let i = 0; i < memories.length; i += SYNC_CONFIG.batchSize) {
    batches.push(memories.slice(i, i + SYNC_CONFIG.batchSize));
  }

  let totalSynced = 0;
  let totalFailed = 0;
  const allErrors: string[] = [];

  for (const batch of batches) {
    const batchResult = await syncBatchWithRetry(teamId, batch);
    totalSynced += batchResult.synced;
    totalFailed += batchResult.failed;
    if (batchResult.errors) {
      allErrors.push(...batchResult.errors);
    }
  }

  return {
    synced: totalSynced,
    failed: totalFailed,
    errors: allErrors,
  };
}

/**
 * Sync a batch with retry logic
 */
async function syncBatchWithRetry(
  teamId: string,
  memories: CreateMemoryInput[]
): Promise<MemorySyncResponse> {
  let lastError: string | undefined;

  for (let attempt = 0; attempt < SYNC_CONFIG.retryAttempts; attempt++) {
    try {
      return await syncMemories(teamId, { memories });
    } catch (err) {
      lastError = err instanceof Error ? err.message : 'Unknown error';

      // Exponential backoff
      if (attempt < SYNC_CONFIG.retryAttempts - 1) {
        const delay = SYNC_CONFIG.retryDelay * Math.pow(2, attempt);
        await sleep(delay);
      }
    }
  }

  // All retries failed
  return {
    synced: 0,
    failed: memories.length,
    errors: [lastError || 'Sync failed after retries'],
  };
}

/**
 * Get sync status summary
 */
export function getSyncStatusSummary(): string {
  const status = getSyncStatus();

  if (!status) {
    return 'Not logged in';
  }

  if (!status.enabled) {
    return 'Sync disabled';
  }

  if (!status.teamId) {
    return 'No team configured';
  }

  return `Syncing to team: ${status.teamId}`;
}
