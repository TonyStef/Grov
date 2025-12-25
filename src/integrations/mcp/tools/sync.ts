// sync helper - syncs task from local store to cloud

import { syncMemories } from '../../../core/cloud/api-client.js';
import { getTask, markSyncing, markSynced, markError } from '../store.js';

export async function syncTaskToCloud(
  taskId: string,
  teamId: string,
  action: 'insert' | 'update',
  matchId?: string
): Promise<void> {
  const task = getTask(taskId);
  if (!task) {
    throw new Error('Task not found');
  }

  markSyncing(taskId);

  try {
    const reasoningTrace = JSON.parse(task.reasoning_trace);
    const decisions = JSON.parse(task.decisions);
    const filesTouched = JSON.parse(task.files_touched);

    await syncMemories(teamId, {
      memories: [{
        client_task_id: taskId,
        project_path: task.project_path,
        original_query: task.original_query,
        goal: task.goal,
        summary: task.summary,
        reasoning_trace: reasoningTrace,
        decisions: decisions,
        files_touched: filesTouched,
        status: 'complete',
        // If update, set memory_id to trigger UPDATE path
        memory_id: action === 'update' ? matchId : undefined,
      }],
    });

    markSynced(taskId, matchId);

  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Sync failed';
    markError(taskId, msg);
    throw err;
  }
}
