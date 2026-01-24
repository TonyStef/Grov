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
import { getCurrentUser } from '../../../core/cloud/credentials.js';
import { reportInjection } from '../../../core/cloud/api-client.js';
import {
  clearSessionState,
  cacheMemories,
  buildMemoryPreview,
  buildToolDescription,
  buildDriftRecoveryInjection,
  reconstructMessages,
  addInjectionRecord,
  commitPendingRecords,
  setCachedPreview,
  getCachedPreview,
} from '../injection/memory-injection.js';
import { handleInjectionResponse } from '../utils/usage-warnings.js';
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

  // === WARMUP CHECK (FIRST - before any injection) ===
  // Skip warmup requests entirely - no tool, no system prompt, nothing
  const rawEarlyPrompt = adapter.getLastUserContent(modified);
  const earlyUserPrompt = rawEarlyPrompt
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/\\n["']?\s*<\/system-reminder>/g, '')
    .replace(/<\/system-reminder>/g, '')
    .trim();
  if (earlyUserPrompt.startsWith('Warmup')) {
    return modified;
  }

  // Save clean user prompt BEFORE any reconstruction/injection (agent-agnostic)
  modified.__grovRawUserPrompt = earlyUserPrompt.substring(0, 500);

  // === TOOL INJECTION (only for real user requests) ===
  const toolDesc = buildToolDescription();
  modified.__grovInjection = toolDesc;
  modified.__grovInjectionCached = false;

  // Add grov_expand tool to tools array (agent-specific format)
  const toolDef = adapter.buildGrovExpandTool();
  modified = adapter.injectTool(modified, toolDef) as Record<string, unknown>;

  const messages = adapter.getMessages(modified) as Array<{ role: string; content: unknown }>;
  const requestType = detectRequestType(messages, sessionInfo.projectPath);
  const sessionState = getSessionState(sessionInfo.sessionId);

  // === COMMIT PENDING RECORDS FROM PREVIOUS TURN ===
  // When a new turn starts, commit any pending records so reconstruction stays consistent
  if (requestType === 'first') {
    commitPendingRecords(sessionInfo.projectPath);
  }

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
    const rawUserPrompt = adapter.getLastUserContent(modified);
    // Clean user prompt - strip Claude Code injections that pollute semantic search
    const userPrompt = rawUserPrompt
      .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
      .replace(/\\n["']?\s*<\/system-reminder>/g, '')
      .replace(/<\/system-reminder>/g, '')
      .replace(/^This session is being continued from a previous conversation[\s\S]*?Summary:/gi, '')
      .replace(/^[\s\n"'\\]+/, '')
      .trim();
    const messagesForFiles = adapter.getMessages(modified);
    const mentionedFiles = extractFilesFromMessages(messagesForFiles as Array<{ role: string; content: unknown }>);

    const syncEnabled = isSyncEnabled();

    if (syncEnabled && teamId && userPrompt) {
      try {
        const memories = await fetchTeamMemories(teamId, sessionInfo.projectPath, {
          status: 'complete',
          limit: 3,
          context: userPrompt,
          current_files: mentionedFiles.length > 0 ? mentionedFiles : undefined,
        });

        if (memories.length > 0) {
          const memoryIds = memories.map(m => m.id.substring(0, 8)).join(', ');
          console.log(`[MEMORY] ${memories.length} memories found: [${memoryIds}]`);

          // Cache for expand tool
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
            modified.__grovUserMsgInjection = userMsgInjection;
            setCachedPreview(sessionInfo.projectPath, userMsgInjection, messages.length);

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

          const user = getCurrentUser();
          if (user && teamId) {
            reportInjection({
              team_id: teamId,
              user_id: user.id,
              session_id: sessionInfo.sessionId,
              event_id: `${sessionInfo.sessionId}:${Date.now()}:preview`,
              injection_type: 'preview',
              memory_ids: memories.map(m => m.id),
              timestamp: new Date().toISOString(),
            })
              .then(res => handleInjectionResponse(res, teamId))
              .catch(() => {});
          }
        } else {
          // No memories found - inject explicit "no entries" so Claude doesn't use old previews
          let noMemoriesMsg = '[PROJECT KNOWLEDGE BASE: No relevant entries for this query]';
          const driftRecovery = buildDriftRecoveryInjection(
            sessionState?.pending_correction,
            sessionState?.pending_forced_recovery
          );
          if (driftRecovery) {
            noMemoriesMsg = `${noMemoriesMsg}\n${driftRecovery}`;
          }
          modified.__grovUserMsgInjection = noMemoriesMsg;
          setCachedPreview(sessionInfo.projectPath, noMemoriesMsg, messages.length);

          // Track for reconstruction
          addInjectionRecord(sessionInfo.projectPath, {
            position: originalLastUserPos,
            type: 'preview',
            preview: noMemoriesMsg,
          });
        }

        // Clear pending corrections after injection
        if (sessionState?.pending_correction || sessionState?.pending_forced_recovery) {
          updateSessionState(sessionInfo.sessionId, {
            pending_correction: undefined,
            pending_forced_recovery: undefined,
          });
        }
      } catch (err) {
        console.error(`[MEMORY] fetchTeamMemories error: ${err}`);
      }
    } else {
      // Sync not enabled - only inject drift/recovery if pending
      const driftRecovery = buildDriftRecoveryInjection(
        sessionState?.pending_correction,
        sessionState?.pending_forced_recovery
      );
      if (driftRecovery) {
        modified.__grovUserMsgInjection = driftRecovery;
        if (sessionState?.pending_correction || sessionState?.pending_forced_recovery) {
          updateSessionState(sessionInfo.sessionId, {
            pending_correction: undefined,
            pending_forced_recovery: undefined,
          });
        }
      }
    }
  } else if (requestType === 'retry') {
    const cached = getCachedPreview(sessionInfo.projectPath, messages.length);
    if (cached) {
      modified.__grovUserMsgInjection = cached;
    }
  }

  return modified;
}
