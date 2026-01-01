// Cloud sync logic - Upload memories from local database to API
// Handles batching, retries, and conversion from Task to Memory format

import type { CreateMemoryInput, MemorySyncResponse, Memory } from '@grov/shared';
import { getSyncStatus, getAccessToken } from './credentials.js';
import { syncMemories, sleep, getApiUrl, fetchMatch } from './api-client.js';
import type { Task } from '../store/store.js';
import type { ExtractedReasoningAndDecisions, ShouldUpdateResult, SupersededMapping, RequestHeaders } from '../extraction/llm-extractor.js';
import { shouldUpdateMemory } from '../extraction/llm-extractor.js';

// ============= Types for Memory Editing =============

/**
 * Evolution step in memory history
 */
export interface EvolutionStep {
  summary: string;  // 100-150 chars describing state at this point
  date: string;     // YYYY-MM-DD format
}

/**
 * Decision with tracking metadata
 */
export interface TrackedDecision {
  choice: string;
  reason: string;
  date?: string;    // YYYY-MM-DD format
  active?: boolean; // false if superseded by newer decision
  superseded_by?: {
    choice: string;   // the new decision that replaced this one
    reason: string;   // why the change was made
    date: string;     // when the replacement happened
  };
}

// ShouldUpdateResult is imported from llm-extractor.ts

/**
 * Extended memory input with fields for UPDATE path
 */
export interface UpdateMemoryInput extends CreateMemoryInput {
  memory_id?: string;                       // if present, triggers UPDATE
  evolution_steps?: EvolutionStep[];
  reasoning_evolution?: Array<{ content: string; date: string }>;
}

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
    client_task_id: task.id,
    project_path: task.project_path,
    original_query: task.original_query,
    goal: task.goal,
    system_name: task.system_name,  // Parent anchor for semantic search
    summary: task.summary,
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
 * Get today's date in ISO format (full timestamp)
 */
function getToday(): string {
  return new Date().toISOString();
}

/**
 * Prepare sync payload for UPDATE path
 * Merges existing memory with new data based on shouldUpdateMemory result
 *
 * @param existingMemory - The memory that was matched
 * @param newData - Extracted reasoning and decisions from current session
 * @param updateResult - Result from shouldUpdateMemory Haiku call
 * @param task - The current task being synced
 * @returns Payload ready for sync with memory_id for UPDATE
 */
export function prepareSyncPayload(
  existingMemory: Memory,
  newData: ExtractedReasoningAndDecisions,
  updateResult: ShouldUpdateResult,
  task: Task
): UpdateMemoryInput {
  const today = getToday();

  // 1. Get existing decisions with proper typing
  const existingDecisions = (existingMemory.decisions || []) as TrackedDecision[];

  // 2. Build lookup for superseded decisions from mapping
  const supersededMap = new Map(
    updateResult.superseded_mapping.map(m => [
      m.old_index,
      {
        choice: m.replaced_by_choice,
        reason: m.replaced_by_reason,
        date: today,
      },
    ])
  );

  // 3. Mark superseded decisions as inactive and add superseded_by info
  const updatedDecisions = existingDecisions.map((d, i) => {
    const replacement = supersededMap.get(i);
    if (replacement) {
      return {
        ...d,
        active: false,
        superseded_by: replacement,
      };
    }
    return {
      ...d,
      active: d.active !== false,
    };
  });

  // 4. Append new decisions with date and active flag
  const newDecisions = newData.decisions.map(d => ({
    ...d,
    date: today,
    active: true,
  }));

  const allDecisions = [...updatedDecisions, ...newDecisions];

  // 4. Handle evolution_steps - use consolidated or existing
  const existingEvolutionSteps = (existingMemory.evolution_steps || []) as EvolutionStep[];
  const baseEvolutionSteps = updateResult.consolidated_evolution_steps || existingEvolutionSteps;

  // 5. Append new evolution step if summary provided
  const evolutionSteps = [...baseEvolutionSteps];
  if (updateResult.evolution_summary) {
    evolutionSteps.push({
      summary: updateResult.evolution_summary,
      date: today,
    });
  }

  // 6. Handle reasoning_evolution - append condensed old reasoning
  const existingReasoningEvolution = (existingMemory.reasoning_evolution || []) as Array<{ content: string; date: string }>;
  const reasoningEvolution = [...existingReasoningEvolution];
  if (updateResult.condensed_old_reasoning) {
    reasoningEvolution.push({
      content: updateResult.condensed_old_reasoning,
      date: today,
    });
  }

  // 7. Truncate arrays to max limits
  const MAX_DECISIONS = 20;
  const MAX_EVOLUTION_STEPS = 10;
  const MAX_REASONING_EVOLUTION = 5;

  const finalDecisions = allDecisions.slice(-MAX_DECISIONS);
  const finalEvolutionSteps = evolutionSteps.slice(-MAX_EVOLUTION_STEPS);
  const finalReasoningEvolution = reasoningEvolution.slice(-MAX_REASONING_EVOLUTION);

  // 8. Build final payload
  return {
    memory_id: existingMemory.id,  // Triggers UPDATE path in API
    client_task_id: task.id,
    project_path: task.project_path,
    original_query: task.original_query,
    goal: task.goal,
    system_name: newData.system_name || task.system_name,  // Parent anchor for semantic search
    reasoning_trace: newData.reasoning_trace,  // OVERWRITE with new
    files_touched: task.files_touched,
    decisions: finalDecisions,
    constraints: task.constraints,
    tags: task.tags,
    status: task.status,
    linked_commit: task.linked_commit,
    evolution_steps: finalEvolutionSteps,
    reasoning_evolution: finalReasoningEvolution,
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
 * Sync a single task to the cloud with memory editing support
 * Called when a task is completed
 *
 * Flow:
 * 1. Check for existing match via /match endpoint
 * 2. If match found: shouldUpdateMemory() decides UPDATE or SKIP
 * 3. If UPDATE: prepareSyncPayload() merges data
 * 4. If no match: INSERT new memory
 *
 * @param task - The task to sync
 * @param extractedData - Optional pre-extracted reasoning and decisions
 * @param taskType - Optional task type for shouldUpdateMemory context
 */
export async function syncTask(
  task: Task,
  extractedData: ExtractedReasoningAndDecisions | undefined,
  taskType: 'information' | 'planning' | 'implementation' | undefined,
  headers: RequestHeaders
): Promise<boolean> {
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
    const taskId = task.id.substring(0, 8);

    // Build effective extracted data from task if not provided
    const effectiveExtractedData = extractedData || (
      (task.reasoning_trace.length > 0 || task.decisions.length > 0)
        ? {
            system_name: task.system_name || null,
            summary: task.summary || null,
            reasoning_trace: task.reasoning_trace,
            decisions: task.decisions,
          }
        : undefined
    );

    // Step 1: Check for existing match
    const matchResult = await fetchMatch(teamId, {
      project_path: task.project_path,
      goal: task.goal,
      original_query: task.original_query,
      reasoning_trace: effectiveExtractedData?.reasoning_trace || task.reasoning_trace,
      decisions: effectiveExtractedData?.decisions || task.decisions,
      task_type: taskType,
    });

    // Step 2: If no match, INSERT as new memory
    if (!matchResult.match) {
      const memory = taskToMemory(task);
      const result = await syncMemories(teamId, { memories: [memory] });
      console.log(`[SYNC TO CLOUD] ${taskId} -> INSERT (${taskType || 'unknown'})`);
      return result.synced === 1;
    }

    const matchedId = matchResult.match.id.substring(0, 8);
    const score = matchResult.combined_score?.toFixed(3) || '-';

    // If no extracted data, INSERT anyway
    if (!effectiveExtractedData) {
      const memory = taskToMemory(task);
      const result = await syncMemories(teamId, { memories: [memory] });
      console.log(`[SYNC TO CLOUD] ${taskId} -> INSERT (${taskType || 'unknown'})`);
      return result.synced === 1;
    }

    // Build session context for shouldUpdateMemory
    const sessionContext = {
      task_type: taskType || 'implementation' as const,
      original_query: task.original_query,
      files_touched: task.files_touched,
    };

    // Call shouldUpdateMemory to decide
    const updateResult = await shouldUpdateMemory(
      {
        id: matchResult.match.id,
        goal: matchResult.match.goal,
        decisions: matchResult.match.decisions || [],
        reasoning_trace: matchResult.match.reasoning_trace || [],
        evolution_steps: (matchResult.match.evolution_steps || []) as EvolutionStep[],
        files_touched: matchResult.match.files_touched || [],
      },
      effectiveExtractedData,
      sessionContext,
      headers
    );

    // If should NOT update, skip sync entirely
    if (!updateResult.should_update) {
      console.log(`[SYNC TO CLOUD] ${taskId} -> SKIP (unchanged) [matched: ${matchedId}]`);
      return true;
    }

    // Prepare payload for UPDATE
    const payload = prepareSyncPayload(
      matchResult.match,
      effectiveExtractedData,
      updateResult,
      task
    );

    // Sync with memory_id for UPDATE path
    const result = await syncMemories(teamId, { memories: [payload as CreateMemoryInput] });
    console.log(`[SYNC TO CLOUD] ${taskId} -> UPDATE (${taskType || 'unknown'}) [matched: ${matchedId}]`);
    return result.synced === 1;

  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.error(`[SYNC TO CLOUD] ERROR: ${msg}`);
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
  syncedIds: string[];
  failedIds: string[];
}> {
  if (!isSyncEnabled()) {
    return {
      synced: 0,
      failed: tasks.length,
      errors: [`Sync is not enabled. Run "grov sync --enable --team <team-id>" first. (API: ${getApiUrl()})`],
      syncedIds: [],
      failedIds: tasks.map(t => t.id),
    };
  }

  const teamId = getSyncTeamId();
  if (!teamId) {
    return {
      synced: 0,
      failed: tasks.length,
      errors: [`No team configured. Run "grov sync --enable --team <team-id>" first. (API: ${getApiUrl()})`],
      syncedIds: [],
      failedIds: tasks.map(t => t.id),
    };
  }

  const token = await getAccessToken();
  if (!token) {
    return {
      synced: 0,
      failed: tasks.length,
      errors: [`Not authenticated. Run "grov login" first. (API: ${getApiUrl()})`],
      syncedIds: [],
      failedIds: tasks.map(t => t.id),
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
  const syncedIds: string[] = [];
  const failedIds: string[] = [];

  for (const batch of batches) {
    const batchResult = await syncBatchWithRetry(teamId, batch);
    totalSynced += batchResult.synced;
    totalFailed += batchResult.failed;
    if (batchResult.errors) {
      allErrors.push(...batchResult.errors);
    }
    const batchIds = batch.map((m) => m.client_task_id || '');
    if (batchResult.synced === batch.length) {
      syncedIds.push(...batchIds);
    } else if (batchResult.failed === batch.length) {
      failedIds.push(...batchIds);
    }
  }

  return {
    synced: totalSynced,
    failed: totalFailed,
    errors: allErrors,
    syncedIds: syncedIds.filter(Boolean),
    failedIds: failedIds.filter(Boolean),
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
