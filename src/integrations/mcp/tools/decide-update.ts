// grov_decide_update - LLM decides UPDATE or SKIP for matched memory

import { getSyncStatus } from '../../../core/cloud/credentials.js';
import { getPendingDecision, clearPendingDecision } from '../cache.js';
import { syncTaskToCloud } from './sync.js';

export async function handleDecideUpdate(
  decision: 'update' | 'skip',
  reason: string
): Promise<string> {
  const pending = getPendingDecision();

  if (!pending) {
    return JSON.stringify({
      error: 'No pending decision. Call grov_save first.',
    });
  }

  const syncStatus = getSyncStatus();
  if (!syncStatus?.enabled || !syncStatus.teamId) {
    clearPendingDecision();
    return JSON.stringify({
      error: 'Sync not enabled.',
    });
  }

  const { taskId, matchedMemory } = pending;

  try {
    if (decision === 'skip') {
      clearPendingDecision();
      return JSON.stringify({
        action: 'skip',
        reason,
        message: 'Memory unchanged.',
      });
    }

    // UPDATE - sync with match_id
    await syncTaskToCloud(taskId, syncStatus.teamId, 'update', matchedMemory.id);
    clearPendingDecision();

    return JSON.stringify({
      action: 'update',
      reason,
      updated_memory_id: matchedMemory.id,
      message: 'Memory updated successfully.',
    });

  } catch (err) {
    clearPendingDecision();
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return JSON.stringify({
      error: msg,
    });
  }
}
