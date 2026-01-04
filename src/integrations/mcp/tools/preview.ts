// grov_preview - fetch relevant memories at conversation start

import { fetchTeamMemories } from '../../../core/cloud/api-client.js';
import { getSyncStatus } from '../../../core/cloud/credentials.js';
import { setPreviewCache, getProjectPath } from '../cache.js';
import { mcpLog, mcpError } from '../logger.js';
import type { Memory } from '@grov/shared';

const MAX_PREVIEW_MEMORIES = 3;

export async function handlePreview(context: string, mode: string): Promise<string> {
  mcpLog('handlePreview starting', { contextLength: context.length, mode });

  const syncStatus = getSyncStatus();
  mcpLog('syncStatus check', {
    enabled: syncStatus?.enabled,
    hasTeamId: !!syncStatus?.teamId,
    teamId: syncStatus?.teamId
  });

  if (!syncStatus?.enabled || !syncStatus.teamId) {
    mcpLog('Sync not enabled, returning empty');
    return JSON.stringify({
      memories: [],
      message: 'Sync not enabled. Run grov login to configure.',
    });
  }

  const projectPath = getProjectPath();
  mcpLog('projectPath resolved', { projectPath });

  try {
    mcpLog('Calling fetchTeamMemories', {
      teamId: syncStatus.teamId,
      projectPath,
      context: context.substring(0, 100)
    });

    const memories = await fetchTeamMemories(syncStatus.teamId, projectPath, {
      context,
      limit: MAX_PREVIEW_MEMORIES,
    });

    mcpLog('fetchTeamMemories returned', { memoriesCount: memories.length });

    if (memories.length === 0) {
      setPreviewCache([]);
      mcpLog('No memories found, returning empty');
      return JSON.stringify({
        memories: [],
        message: 'No memories for THIS context. IMPORTANT: Call grov_preview again at your NEXT prompt - different question may match different memories. Each prompt needs its own preview call.',
      });
    }

    // Cache memories (indexed by 8-char ID internally)
    setPreviewCache(memories);

    // Format preview list with 8-char IDs
    const previewList = memories.map((m) => ({
      id: m.id.substring(0, 8),
      goal: m.goal,
      summary: m.summary,
    }));

    return JSON.stringify({
      memories: previewList,
      message: `Found ${memories.length} relevant memories. Call grov_expand with memory ID to see details.`,
    });

  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    mcpError('fetchTeamMemories failed', err);
    return JSON.stringify({
      memories: [],
      error: msg,
    });
  }
}
