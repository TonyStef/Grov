// grov_preview - fetch relevant memories at conversation start

import { fetchTeamMemories } from '../../../core/cloud/api-client.js';
import { getSyncStatus } from '../../../core/cloud/credentials.js';
import { setPreviewCache, getProjectPath } from '../cache.js';
import type { Memory } from '@grov/shared';

const MAX_PREVIEW_MEMORIES = 5;

export async function handlePreview(context: string, mode: string): Promise<string> {
  const syncStatus = getSyncStatus();

  if (!syncStatus?.enabled || !syncStatus.teamId) {
    return JSON.stringify({
      memories: [],
      message: 'Sync not enabled. Run grov login to configure.',
    });
  }

  const projectPath = getProjectPath();

  try {
    const memories = await fetchTeamMemories(syncStatus.teamId, projectPath, {
      context,
      limit: MAX_PREVIEW_MEMORIES,
    });

    if (memories.length === 0) {
      setPreviewCache([], []);
      return JSON.stringify({
        memories: [],
        message: 'No relevant memories found.',
      });
    }

    // Cache all fetched memories, track shown indices
    const shownIndices = memories.map((_, i) => i + 1);
    setPreviewCache(memories, shownIndices);

    // Format preview list
    const previewList = memories.map((m, i) => ({
      index: i + 1,
      goal: m.goal,
      summary: m.summary,
    }));

    return JSON.stringify({
      memories: previewList,
      message: `Found ${memories.length} relevant memories. Call grov_expand with indices to see details.`,
    });

  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return JSON.stringify({
      memories: [],
      error: msg,
    });
  }
}
