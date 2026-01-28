import { config } from '../config.js';
import { extractFilesFromMessages } from '../request-processor.js';
import { fetchTeamMemories, fetchTeamPlans } from '../../../core/cloud/api-client.js';
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
  buildPlanPreview,
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

interface PendingPlanClear {
  projectPath: string;
  summary: string;
}

let pendingPlanClear: PendingPlanClear | null = null;

export function getPendingPlanClear(): PendingPlanClear | null {
  return pendingPlanClear;
}

export function setPendingPlanClear(value: PendingPlanClear): void {
  pendingPlanClear = value;
}

export function clearPendingPlan(): void {
  pendingPlanClear = null;
}

const MAX_RAW_PROMPT_LENGTH = 500;

function cleanUserPrompt(rawPrompt: string): string {
  return rawPrompt
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/\\n["']?\s*<\/system-reminder>/g, '')
    .replace(/<\/system-reminder>/g, '')
    .trim();
}

function isWarmupRequest(userPrompt: string): boolean {
  return userPrompt.startsWith('Warmup');
}

export async function preProcessRequest(
  adapter: AgentAdapter,
  body: unknown,
  sessionInfo: { sessionId: string; promptCount: number; projectPath: string },
  logger: { info: (data: Record<string, unknown>) => void },
  detectRequestType: (messages: Array<{ role: string; content: unknown }>, projectPath: string) => 'first' | 'continuation' | 'retry'
): Promise<unknown> {
  let modified = { ...(body as Record<string, unknown>) };

  const rawEarlyPrompt = adapter.getLastUserContent(modified);
  const earlyUserPrompt = cleanUserPrompt(rawEarlyPrompt);

  if (isWarmupRequest(earlyUserPrompt)) {
    return modified;
  }

  modified.__grovRawUserPrompt = earlyUserPrompt.substring(0, MAX_RAW_PROMPT_LENGTH);

  const toolDesc = buildToolDescription();
  modified.__grovInjection = toolDesc;
  modified.__grovInjectionCached = false;

  const toolDef = adapter.buildGrovExpandTool();
  modified = adapter.injectTool(modified, toolDef) as Record<string, unknown>;

  const messages = adapter.getMessages(modified) as Array<{ role: string; content: unknown }>;
  const requestType = detectRequestType(messages, sessionInfo.projectPath);
  const sessionState = getSessionState(sessionInfo.sessionId);

  if (requestType === 'first') {
    commitPendingRecords(sessionInfo.projectPath);
  }

  if (pendingPlanClear?.projectPath === sessionInfo.projectPath) {
    modified = adapter.setMessages(modified, []) as Record<string, unknown>;
    modified = adapter.injectMemory(modified, pendingPlanClear.summary) as Record<string, unknown>;
    clearPendingPlan();
    clearSessionState(sessionInfo.projectPath);
    return modified;
  }

  if (sessionState) {
    const currentTokenCount = sessionState.token_count || 0;
    const shouldClear = currentTokenCount > config.TOKEN_CLEAR_THRESHOLD &&
                        sessionState.pending_clear_summary;

    if (shouldClear) {
      logger.info({
        msg: 'CLEAR MODE ACTIVATED',
        tokenCount: currentTokenCount,
        threshold: config.TOKEN_CLEAR_THRESHOLD,
      });

      modified = adapter.setMessages(modified, []) as Record<string, unknown>;
      modified = adapter.injectMemory(modified, sessionState.pending_clear_summary!) as Record<string, unknown>;
      markCleared(sessionInfo.sessionId);

      updateSessionState(sessionInfo.sessionId, { pending_clear_summary: undefined });
      clearSessionState(sessionInfo.projectPath);

      return modified;
    }
  }

  function findLastUserMessagePosition(messages: unknown[]): number {
    for (let i = messages.length - 1; i >= 0; i--) {
      if ((messages[i] as { role?: string })?.role === 'user') {
        return i;
      }
    }
    return messages.length - 1;
  }

  const originalMessages = adapter.getMessages(modified);
  const originalLastUserPos = findLastUserMessagePosition(originalMessages);

  const currentMessages = adapter.getMessages(modified) as Array<{ role: string; content: unknown }>;
  const { messages: reconstructedMsgs, reconstructedCount } = reconstructMessages(
    currentMessages,
    sessionInfo.projectPath
  );

  if (reconstructedCount > 0) {
    modified = adapter.setMessages(modified, reconstructedMsgs) as Record<string, unknown>;
    modified.__grovReconstructedCount = reconstructedCount;
  }

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

      // Fetch and inject team plans (separate try/catch - plan failure shouldn't block memories)
      try {
        const plans = await fetchTeamPlans(teamId);
        if (plans.length > 0) {
          const planPreview = buildPlanPreview(plans);
          if (planPreview) {
            const currentInjection = modified.__grovUserMsgInjection as string || '';
            modified.__grovUserMsgInjection = currentInjection
              ? `${currentInjection}\n\n${planPreview}`
              : planPreview;

            // Update cached preview for retry handling
            setCachedPreview(sessionInfo.projectPath, modified.__grovUserMsgInjection as string, messages.length);

            console.log(`[PLANS] ${plans.length} active plans injected`);
          }
        }
      } catch (err) {
        console.error(`[PLANS] fetchTeamPlans error: ${err}`);
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
