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
    const res = await request(`${API_URL}/teams/${teamId}/cursor/extract`, {
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
  if (isSynced(composerId, usageUuid)) return;

  const pair = getConversationPair(composerId, usageUuid);
  if (!pair) return;

  const mode = pair.assistant.unifiedMode;

  // Warn if text is empty (helps debug text=0 issue)
  if (pair.assistant.text.length === 0) {
    mcpLog(`[hook] WARNING: Assistant text is EMPTY for ${usageUuid.substring(0, 8)}...`);
  }

  // Ask mode (1): skip
  if (mode === 1) {
    markSynced(composerId, usageUuid);
    return;
  }

  // Plan mode (5): accumulate
  if (mode === 5) {
    addToPlanState(composerId, usageUuid);
    return;
  }

  // Agent mode (2): check if we have accumulated plan to send first
  const planState = getPlanState();
  if (planState && planState.composerId === composerId) {
    for (const planUuid of planState.usageUuids) {
      if (isSynced(composerId, planUuid)) continue;
      const planPair = getConversationPair(composerId, planUuid);
      if (!planPair) continue;
      const planPayload = buildPayload(planPair, projectPath);
      const success = await postToApi(teamId, token, planPayload);
      if (success) markSynced(composerId, planUuid);
    }
    clearPlanState();
  }

  // Send current agent message
  const payload = buildPayload(pair, projectPath);
  const success = await postToApi(teamId, token, payload);

  if (success) {
    markSynced(composerId, usageUuid);
  } else {
    mcpLog(`[hook] Failed to sync ${usageUuid.substring(0, 8)}...`);
  }
}

// Helper to sleep
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  mcpLog(`[hook] started`);

  // Wait 3 seconds to let Cursor finish writing to SQLite
  await sleep(3000);

  // Check prerequisites
  if (!dbExists()) process.exit(0);

  const syncStatus = getSyncStatus();
  if (!syncStatus?.enabled || !syncStatus.teamId) process.exit(0);

  const token = await getAccessToken();
  if (!token) process.exit(0);

  const teamId = syncStatus.teamId;

  // Handle any timed-out plan from a DIFFERENT conversation
  await handlePlanTimeout(teamId, token);

  // Get latest composer (skips empty ones)
  const composerId = getLatestComposerId();
  if (!composerId) process.exit(0);

  const composer = getComposerData(composerId);
  if (!composer) process.exit(0);

  // Get latest prompt (usageUuid) with content
  const usageUuid = getLatestPromptId(composerId);
  if (!usageUuid) process.exit(0);

  // Get project path from current workspace (MRU list)
  const projectPath = getCurrentWorkspace() || composer.projectPath;

  await handleCurrentPrompt(teamId, token, composerId, usageUuid, projectPath);
  mcpLog(`[hook] finished`);
}

main().catch((err) => {
  mcpLog(`[main] Fatal error: ${err instanceof Error ? err.message : 'unknown'}`);
  process.exit(1);
});
