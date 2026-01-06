// CLI Transform - Convert CLI Turn data to API format and POST to extraction endpoint
// Reuses same /cursor/extract endpoint as IDE capture

import { request } from 'undici';
import { getAccessToken, getSyncStatus } from '../../../core/cloud/credentials.js';
import type { Turn } from './cli-extractor.js';

const API_URL = process.env.GROV_API_URL || 'https://api.grov.dev';

interface ExtractPayload {
  composerId: string;
  usageUuid: string;
  mode: 'ask' | 'plan' | 'agent';
  projectPath: string;
  original_query: string;
  text: string;
  thinking: string;
  toolCalls: Array<{ name: string; params: Record<string, unknown> }>;
}

interface MetaData {
  agentId: string;
  lastUsedModel: string;
  mode?: string;
}

/**
 * Transform CLI Turn to API ExtractPayload format
 * CLI always uses 'agent' mode (no ask/plan distinction in CLI)
 */
export function transformToApiFormat(turn: Turn, meta: MetaData): ExtractPayload {
  return {
    composerId: meta.agentId,
    usageUuid: turn.usageUuid,
    mode: 'agent', // CLI always agent mode
    projectPath: turn.projectPath || 'unknown',
    original_query: turn.userPrompt,
    text: turn.assistantTexts.join('\n'),
    thinking: turn.reasoningBlocks.join('\n\n'),
    toolCalls: turn.toolCalls.map(tc => ({
      name: tc.toolName,
      params: tc.args
    }))
  };
}

/**
 * Post extracted turn to API
 * Returns true on success, false on failure
 */
export async function postToApi(payload: ExtractPayload): Promise<boolean> {
  const syncStatus = getSyncStatus();
  if (!syncStatus?.enabled || !syncStatus.teamId) return false;

  const token = await getAccessToken();
  if (!token) return false;

  const teamId = syncStatus.teamId;
  const url = `${API_URL}/teams/${teamId}/cursor/extract`;

  try {
    const res = await request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });

    return res.statusCode === 200;
  } catch {
    return false;
  }
}

/**
 * Check if CLI capture is enabled (sync enabled + team ID set)
 */
export function isCLICaptureEnabled(): boolean {
  const syncStatus = getSyncStatus();
  return syncStatus?.enabled === true && !!syncStatus.teamId;
}
