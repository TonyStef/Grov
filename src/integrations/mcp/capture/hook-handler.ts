#!/usr/bin/env node
// Cursor Stop Hook Handler
// Called by Cursor after each LLM response
// Reads from SQLite, handles mode logic, POSTs to API

import {
  getLatestComposerId,
  getComposerData,
  getLatestPromptId,
  getConversationPair,
  getCurrentWorkspace,
  dbExists,
  type ConversationPair,
} from './sqlite-reader.js';

import {
  isSynced,
  markSynced,
  getPlanState,
  addToPlanState,
  clearPlanState,
  isPlanTimedOut,
} from './sync-tracker.js';

import { getAccessToken, getSyncStatus } from '../../../core/cloud/credentials.js';
import { request } from 'undici';
import { mcpLog } from '../logger.js';

const API_URL = process.env.GROV_API_URL || 'https://api.grov.dev';
const PLAN_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

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

function modeNumToString(num: 1 | 2 | 5): 'ask' | 'plan' | 'agent' {
  if (num === 1) return 'ask';
  if (num === 5) return 'plan';
  return 'agent';
}

async function postToApi(teamId: string, token: string, payload: ExtractPayload): Promise<boolean> {
  try {
    mcpLog(`[postToApi] Sending to ${API_URL}/teams/${teamId}/cursor/extract`);
    const res = await request(`${API_URL}/teams/${teamId}/cursor/extract`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });

    mcpLog(`[postToApi] Response status: ${res.statusCode}`);
    return res.statusCode === 200;
  } catch (err) {
    mcpLog(`[postToApi] Error: ${err instanceof Error ? err.message : 'unknown'}`);
    return false;
  }
}

function buildPayload(
  pair: ConversationPair,
  projectPath: string
): ExtractPayload {
  return {
    composerId: pair.assistant.composerId,
    usageUuid: pair.assistant.usageUuid,
    mode: modeNumToString(pair.assistant.unifiedMode),
    projectPath,
    original_query: pair.user.text,
    text: pair.assistant.text,
    thinking: pair.assistant.thinking,
    toolCalls: pair.assistant.toolCalls,
  };
}

// Syncs accumulated plan messages if the plan session has been idle too long.
async function handlePlanTimeout(teamId: string, token: string): Promise<void> {
  const planState = getPlanState();
  if (!planState || !isPlanTimedOut(PLAN_TIMEOUT_MS)) return;

  mcpLog(`[handlePlanTimeout] Plan timed out, flushing ${planState.usageUuids.length} prompts`);

  const composer = getComposerData(planState.composerId);
  if (!composer) {
    clearPlanState();
    return;
  }

  for (const usageUuid of planState.usageUuids) {
    if (isSynced(planState.composerId, usageUuid)) continue;

    const pair = getConversationPair(planState.composerId, usageUuid);
    if (!pair) continue;

    const payload = buildPayload(pair, composer.projectPath);
    const success = await postToApi(teamId, token, payload);

    if (success) {
      markSynced(planState.composerId, usageUuid);
    }
  }

  clearPlanState();
}

async function handleCurrentPrompt(
  teamId: string,
  token: string,
  composerId: string,
  usageUuid: string,
  projectPath: string
): Promise<void> {
  // Already synced?
  if (isSynced(composerId, usageUuid)) {
    mcpLog(`[handleCurrentPrompt] Already synced: ${usageUuid.substring(0, 8)}...`);
    return;
  }

  // Get aggregated conversation pair
  const pair = getConversationPair(composerId, usageUuid);
  if (!pair) {
    mcpLog(`[handleCurrentPrompt] No pair found for ${usageUuid.substring(0, 8)}...`);
    return;
  }

  const mode = pair.assistant.unifiedMode;
  mcpLog(`[handleCurrentPrompt] Mode: ${modeNumToString(mode)}, bubbles: ${pair.assistant.bubbleCount}`);

  // Ask mode (1): skip
  if (mode === 1) {
    mcpLog(`[handleCurrentPrompt] Ask mode - marking synced without sending`);
    markSynced(composerId, usageUuid);
    return;
  }

  // Plan mode (5): accumulate
  if (mode === 5) {
    mcpLog(`[handleCurrentPrompt] Plan mode - accumulating`);
    addToPlanState(composerId, usageUuid);
    return;
  }

  // Agent mode (2): check if we have accumulated plan to send first
  const planState = getPlanState();
  if (planState && planState.composerId === composerId) {
    mcpLog(`[handleCurrentPrompt] Plan->Agent transition, flushing ${planState.usageUuids.length} plan prompts`);

    for (const planUuid of planState.usageUuids) {
      if (isSynced(composerId, planUuid)) continue;

      const planPair = getConversationPair(composerId, planUuid);
      if (!planPair) continue;

      const planPayload = buildPayload(planPair, projectPath);
      const success = await postToApi(teamId, token, planPayload);
      if (success) {
        markSynced(composerId, planUuid);
      }
    }
    clearPlanState();
  }

  // Now send current agent message
  const payload = buildPayload(pair, projectPath);
  const success = await postToApi(teamId, token, payload);

  if (success) {
    mcpLog(`[handleCurrentPrompt] Successfully synced ${usageUuid.substring(0, 8)}...`);
    markSynced(composerId, usageUuid);
  } else {
    mcpLog(`[handleCurrentPrompt] Failed to sync ${usageUuid.substring(0, 8)}...`);
  }
}

async function main(): Promise<void> {
  mcpLog(`[main] Hook handler started`);

  // Check prerequisites
  if (!dbExists()) {
    mcpLog(`[main] Cursor SQLite not found, exiting`);
    process.exit(0);
  }

  const syncStatus = getSyncStatus();
  if (!syncStatus?.enabled || !syncStatus.teamId) {
    mcpLog(`[main] Sync not enabled or no team ID, exiting`);
    process.exit(0);
  }

  const token = await getAccessToken();
  if (!token) {
    mcpLog(`[main] No access token, exiting`);
    process.exit(0);
  }

  const teamId = syncStatus.teamId;
  mcpLog(`[main] Team: ${teamId}`);

  // First: handle any timed-out plan from a DIFFERENT conversation
  await handlePlanTimeout(teamId, token);

  // Get latest composer (skips empty ones)
  const composerId = getLatestComposerId();
  if (!composerId) {
    mcpLog(`[main] No composer with bubbles found, exiting`);
    process.exit(0);
  }

  const composer = getComposerData(composerId);
  if (!composer) {
    mcpLog(`[main] Composer data not found, exiting`);
    process.exit(0);
  }

  mcpLog(`[main] Composer: ${composerId.substring(0, 8)}..., project: ${composer.projectPath || '(none)'}`);

  // Get latest prompt (usageUuid) with content
  const usageUuid = getLatestPromptId(composerId);
  if (!usageUuid) {
    mcpLog(`[main] No valid prompt found, exiting`);
    process.exit(0);
  }

  // Get project path from current workspace (MRU list)
  const projectPath = getCurrentWorkspace() || composer.projectPath;
  mcpLog(`[main] Final project path: ${projectPath || '(none)'}`);

  await handleCurrentPrompt(teamId, token, composerId, usageUuid, projectPath);
  mcpLog(`[main] Hook handler finished`);
}

main().catch((err) => {
  mcpLog(`[main] Fatal error: ${err instanceof Error ? err.message : 'unknown'}`);
  process.exit(1);
});
