// Pre-process requests before forwarding to Anthropic

import { config } from '../config.js';
import { extractLastUserPrompt, extractFilesFromMessages } from '../request-processor.js';
import { fetchTeamMemories } from '../../../core/cloud/api-client.js';
import {
  getSessionState,
  updateSessionState,
  markCleared,
} from '../../../core/store/store.js';
import { isSyncEnabled, getSyncTeamId } from '../../../core/cloud/cloud-sync.js';
import {
  clearSessionState,
  cacheMemories,
  getCachedMemories,
  buildMemoryPreview,
  buildToolDescription,
  buildToolDefinition,
  buildDriftRecoveryInjection,
  reconstructMessages,
  addInjectionRecord,
} from '../injection/memory-injection.js';
import { appendToSystemPrompt } from '../injection/injectors.js';
import type { MessagesRequestBody } from '../types.js';

let pendingPlanClear: { projectPath: string; summary: string } | null = null;

export function getPendingPlanClear(): { projectPath: string; summary: string } | null {
  return pendingPlanClear;
}

export function setPendingPlanClear(value: { projectPath: string; summary: string }): void {
  pendingPlanClear = value;
}

export function clearPendingPlan(): void {
  pendingPlanClear = null;
}

export async function preProcessRequest(
  body: MessagesRequestBody,
  sessionInfo: { sessionId: string; promptCount: number; projectPath: string },
  logger: { info: (data: Record<string, unknown>) => void },
  detectRequestType: (messages: Array<{ role: string; content: unknown }>, projectPath: string) => 'first' | 'continuation' | 'retry'
): Promise<MessagesRequestBody> {
  const modified = { ...body };

  // === TOOL INJECTION (FIRST - before any early returns for cache consistency) ===
  // System prompt must be identical from first request to maintain prefix cache
  const toolDesc = buildToolDescription();
  (modified as Record<string, unknown>).__grovInjection = toolDesc;
  (modified as Record<string, unknown>).__grovInjectionCached = false;

  // Add grov_expand tool to tools array
  const toolDef = buildToolDefinition();
  if (!modified.tools) {
    modified.tools = [];
  }
  if (!modified.tools.some((t: { name?: string }) => t.name === 'grov_expand')) {
    modified.tools.push(toolDef as never);
  }

  const earlyUserPrompt = extractLastUserPrompt(modified.messages || []);
  if (earlyUserPrompt === 'Warmup') {
    return modified;
  }

  const requestType = detectRequestType(modified.messages || [], sessionInfo.projectPath);
  const sessionState = getSessionState(sessionInfo.sessionId);

  // === PLANNING CLEAR ===
  if (pendingPlanClear && pendingPlanClear.projectPath === sessionInfo.projectPath) {
    modified.messages = [];
    appendToSystemPrompt(modified, pendingPlanClear.summary);
    pendingPlanClear = null;
    clearSessionState(sessionInfo.projectPath);
    return modified;
  }

  // === CLEAR MODE (token threshold) ===
  if (sessionState) {
    const currentTokenCount = sessionState.token_count || 0;

    if (currentTokenCount > config.TOKEN_CLEAR_THRESHOLD && sessionState.pending_clear_summary) {
      logger.info({
        msg: 'CLEAR MODE ACTIVATED',
        tokenCount: currentTokenCount,
        threshold: config.TOKEN_CLEAR_THRESHOLD,
      });

      modified.messages = [];
      appendToSystemPrompt(modified, sessionState.pending_clear_summary);
      markCleared(sessionInfo.sessionId);

      updateSessionState(sessionInfo.sessionId, { pending_clear_summary: undefined });
      clearSessionState(sessionInfo.projectPath);

      return modified;
    }
  }

  // Capture original position BEFORE reconstruction (for injection tracking)
  const originalMessages = modified.messages || [];
  let originalLastUserPos = originalMessages.length - 1;
  for (let i = originalMessages.length - 1; i >= 0; i--) {
    if ((originalMessages[i] as { role?: string })?.role === 'user') {
      originalLastUserPos = i;
      break;
    }
  }

  // === RECONSTRUCT HISTORICAL INJECTIONS (for cache consistency) ===
  const { messages: reconstructedMsgs, reconstructedCount } = reconstructMessages(
    modified.messages || [],
    sessionInfo.projectPath
  );
  if (reconstructedCount > 0) {
    modified.messages = reconstructedMsgs;
    (modified as Record<string, unknown>).__grovReconstructedCount = reconstructedCount;
  }

  // Pass original position to server.ts for tool_cycle tracking
  (modified as Record<string, unknown>).__grovOriginalLastUserPos = originalLastUserPos;

  // === MEMORY PREVIEW INJECTION (new system) ===
  if (requestType === 'first') {
    const teamId = getSyncTeamId();
    const userPrompt = extractLastUserPrompt(modified.messages || []);
    const mentionedFiles = extractFilesFromMessages(modified.messages || []);

    if (isSyncEnabled() && teamId && userPrompt) {
      try {
        const memories = await fetchTeamMemories(teamId, sessionInfo.projectPath, {
          status: 'complete',
          limit: 3,
          context: userPrompt,
          current_files: mentionedFiles.length > 0 ? mentionedFiles : undefined,
        });

        if (memories.length > 0) {
          // Cache for expand tool (keyed by projectPath for cross-task persistence)
          cacheMemories(sessionInfo.projectPath, memories);

          // Build preview for user message
          const preview = buildMemoryPreview(memories);

          // Build drift/recovery if pending
          const driftRecovery = buildDriftRecoveryInjection(
            sessionState?.pending_correction,
            sessionState?.pending_forced_recovery
          );

          // Combine preview + drift/recovery
          let userMsgInjection = preview || '';
          if (driftRecovery) {
            userMsgInjection = userMsgInjection ? `${userMsgInjection}\n${driftRecovery}` : driftRecovery;
          }

          if (userMsgInjection) {
            (modified as Record<string, unknown>).__grovUserMsgInjection = userMsgInjection;

            // Track for reconstruction on next request (use ORIGINAL position)
            addInjectionRecord(sessionInfo.projectPath, {
              position: originalLastUserPos,
              type: 'preview',
              preview: userMsgInjection,
            });
          }

          logger.info({
            msg: 'Memory preview injected',
            memoriesCount: memories.length,
            previewSize: preview?.length || 0,
            hasDriftRecovery: !!driftRecovery,
          });
        } else {
          // No memories found - only inject drift/recovery if pending
          const driftRecovery = buildDriftRecoveryInjection(
            sessionState?.pending_correction,
            sessionState?.pending_forced_recovery
          );
          if (driftRecovery) {
            (modified as Record<string, unknown>).__grovUserMsgInjection = driftRecovery;
          }
        }

        // Clear pending corrections after injection
        if (sessionState?.pending_correction || sessionState?.pending_forced_recovery) {
          updateSessionState(sessionInfo.sessionId, {
            pending_correction: undefined,
            pending_forced_recovery: undefined,
          });
        }
      } catch (err) {
        console.error(`[PREPROCESS] Memory fetch failed: ${err}`);
      }
    } else {
      // Sync not enabled - only inject drift/recovery if pending
      const driftRecovery = buildDriftRecoveryInjection(
        sessionState?.pending_correction,
        sessionState?.pending_forced_recovery
      );
      if (driftRecovery) {
        (modified as Record<string, unknown>).__grovUserMsgInjection = driftRecovery;
        if (sessionState?.pending_correction || sessionState?.pending_forced_recovery) {
          updateSessionState(sessionInfo.sessionId, {
            pending_correction: undefined,
            pending_forced_recovery: undefined,
          });
        }
      }
    }
  }

  return modified;
}
