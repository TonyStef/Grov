// Pre-process requests before forwarding to upstream API (agent-agnostic)

import { config } from '../config.js';
import { extractFilesFromMessages } from '../request-processor.js';
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
  buildMemoryPreview,
  buildToolDescription,
  buildDriftRecoveryInjection,
  reconstructMessages,
  addInjectionRecord,
} from '../injection/memory-injection.js';
import type { AgentAdapter } from '../agents/types.js';

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
  adapter: AgentAdapter,
  body: unknown,
  sessionInfo: { sessionId: string; promptCount: number; projectPath: string },
  logger: { info: (data: Record<string, unknown>) => void },
  detectRequestType: (messages: Array<{ role: string; content: unknown }>, projectPath: string) => 'first' | 'continuation' | 'retry'
): Promise<unknown> {
  let modified = { ...(body as Record<string, unknown>) };

  // === TOOL INJECTION (FIRST - before any early returns for cache consistency) ===
  // System prompt must be identical from first request to maintain prefix cache
  const toolDesc = buildToolDescription();
  modified.__grovInjection = toolDesc;
  modified.__grovInjectionCached = false;

  // Add grov_expand tool to tools array (agent-specific format)
  const toolDef = adapter.buildGrovExpandTool();
  modified = adapter.injectTool(modified, toolDef) as Record<string, unknown>;

  const earlyUserPrompt = adapter.getLastUserContent(modified);
  if (earlyUserPrompt === 'Warmup') {
    return modified;
  }

  const messages = adapter.getMessages(modified) as Array<{ role: string; content: unknown }>;
  const requestType = detectRequestType(messages, sessionInfo.projectPath);
  const sessionState = getSessionState(sessionInfo.sessionId);

  // === PLANNING CLEAR ===
  if (pendingPlanClear && pendingPlanClear.projectPath === sessionInfo.projectPath) {
    modified = adapter.setMessages(modified, []) as Record<string, unknown>;
    modified = adapter.injectMemory(modified, pendingPlanClear.summary) as Record<string, unknown>;
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

      modified = adapter.setMessages(modified, []) as Record<string, unknown>;
      modified = adapter.injectMemory(modified, sessionState.pending_clear_summary) as Record<string, unknown>;
      markCleared(sessionInfo.sessionId);

      updateSessionState(sessionInfo.sessionId, { pending_clear_summary: undefined });
      clearSessionState(sessionInfo.projectPath);

      return modified;
    }
  }

  // Capture original position BEFORE reconstruction (for injection tracking)
  const originalMessages = adapter.getMessages(modified);
  let originalLastUserPos = originalMessages.length - 1;
  for (let i = originalMessages.length - 1; i >= 0; i--) {
    if ((originalMessages[i] as { role?: string })?.role === 'user') {
      originalLastUserPos = i;
      break;
    }
  }

  // === RECONSTRUCT HISTORICAL INJECTIONS (for cache consistency) ===
  const currentMessages = adapter.getMessages(modified) as Array<{ role: string; content: unknown }>;
  const { messages: reconstructedMsgs, reconstructedCount } = reconstructMessages(
    currentMessages,
    sessionInfo.projectPath
  );
  if (reconstructedCount > 0) {
    modified = adapter.setMessages(modified, reconstructedMsgs) as Record<string, unknown>;
    modified.__grovReconstructedCount = reconstructedCount;
  }

  // Pass original position to orchestrator for tool_cycle tracking
  modified.__grovOriginalLastUserPos = originalLastUserPos;

  // === MEMORY PREVIEW INJECTION (new system) ===
  if (requestType === 'first') {
    const teamId = getSyncTeamId();
    const userPrompt = adapter.getLastUserContent(modified);
    const messagesForFiles = adapter.getMessages(modified);
    const mentionedFiles = extractFilesFromMessages(messagesForFiles as Array<{ role: string; content: unknown }>);

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
