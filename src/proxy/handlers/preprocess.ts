// Pre-process requests before forwarding to Anthropic

import { config } from '../config.js';
import { extractLastUserPrompt, extractFilesFromMessages, buildTeamMemoryContextCloud } from '../request-processor.js';
import {
  getSessionState,
  updateSessionState,
  markCleared,
} from '../../lib/store.js';
import { isSyncEnabled, getSyncTeamId } from '../../lib/cloud-sync.js';
import { globalTeamMemoryCache, setTeamMemoryCache, invalidateTeamMemoryCache } from '../cache.js';
import { buildDynamicInjection, clearSessionTracking } from '../injection/delta-tracking.js';
import { appendToSystemPrompt } from '../injection/injectors.js';
import type { MessagesRequestBody } from '../types.js';

// Pending plan summary state - triggers CLEAR-like reset after planning task completes
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

  // Skip warmup requests - Claude Code sends "Warmup" as health check
  // No need to do semantic search or cache operations for these
  const earlyUserPrompt = extractLastUserPrompt(modified.messages || []);
  if (earlyUserPrompt === 'Warmup') {
    console.log('[INJECT] Skipping warmup request (no search, no cache)');
    return modified;
  }

  // Detect request type: first, continuation, or retry
  const requestType = detectRequestType(modified.messages || [], sessionInfo.projectPath);

  // === NEW ARCHITECTURE: Separate static and dynamic injection ===
  //
  // STATIC (system prompt, cached):
  //   - Team memory from PAST sessions only
  //   - CLEAR summary when triggered
  //   -> Uses __grovInjection + injectIntoRawBody()
  //
  // DYNAMIC (user message, delta only):
  //   - Files edited in current session
  //   - Key decisions with reasoning
  //   - Drift correction, forced recovery
  //   -> Uses __grovUserMsgInjection + appendToLastUserMessage()

  // Get session state
  const sessionState = getSessionState(sessionInfo.sessionId);

  // === PLANNING CLEAR: Reset after planning task completes ===
  // This ensures implementation phase starts fresh with planning context from team memory
  if (pendingPlanClear && pendingPlanClear.projectPath === sessionInfo.projectPath) {
    // 1. Empty messages array (fresh start)
    modified.messages = [];

    // 2. Inject planning summary into system prompt
    appendToSystemPrompt(modified, pendingPlanClear.summary);

    // 3. Rebuild team memory NOW (includes the just-saved planning task)
    const mentionedFiles = extractFilesFromMessages(modified.messages || []);
    const userPrompt = extractLastUserPrompt(modified.messages || []);

    // Use cloud-first approach if sync is enabled
    let teamContext: string | null = null;
    const teamId = getSyncTeamId();

    if (isSyncEnabled() && teamId) {
      console.log(`[INJECT] PLANNING_CLEAR: Using cloud team memory (teamId=${teamId.substring(0, 8)}...)`);
      teamContext = await buildTeamMemoryContextCloud(
        teamId,
        sessionInfo.projectPath,
        mentionedFiles,
        userPrompt  // For hybrid semantic search
      );
    } else {
      // Sync not enabled - no injection (cloud-first approach)
      console.log('[INJECT] Sync not enabled. Enable sync for team memory injection.');
      teamContext = null;
    }

    if (teamContext) {
      (modified as Record<string, unknown>).__grovInjection = teamContext;
      (modified as Record<string, unknown>).__grovInjectionCached = false;
      // Update cache with fresh team memory
      setTeamMemoryCache(sessionInfo.projectPath, teamContext);
    }

    // 4. Clear the pending plan (one-time use)
    pendingPlanClear = null;

    // 5. Clear tracking (fresh start)
    clearSessionTracking(sessionInfo.sessionId);

    return modified;  // Skip other injections - this is a complete reset
  }

  // === CLEAR MODE (100% threshold) ===
  // If token count exceeds threshold AND we have a pre-computed summary, apply CLEAR
  if (sessionState) {
    const currentTokenCount = sessionState.token_count || 0;

    if (currentTokenCount > config.TOKEN_CLEAR_THRESHOLD &&
        sessionState.pending_clear_summary) {

      logger.info({
        msg: 'CLEAR MODE ACTIVATED - resetting conversation',
        tokenCount: currentTokenCount,
        threshold: config.TOKEN_CLEAR_THRESHOLD,
        summaryLength: sessionState.pending_clear_summary.length,
      });

      // 1. Empty messages array (fundamental reset)
      modified.messages = [];

      // 2. Inject summary into system prompt (this will cause cache miss - intentional)
      appendToSystemPrompt(modified, sessionState.pending_clear_summary);

      // 3. Mark session as cleared
      markCleared(sessionInfo.sessionId);

      // 4. Clear pending summary and invalidate GLOBAL team memory cache (new baseline)
      updateSessionState(sessionInfo.sessionId, { pending_clear_summary: undefined });
      invalidateTeamMemoryCache();  // Force recalculation on next request (CLEAR mode)

      // 5. Clear tracking (fresh start after CLEAR)
      clearSessionTracking(sessionInfo.sessionId);

      logger.info({ msg: 'CLEAR complete - conversation reset with summary' });

      return modified;  // Skip other injections - this is a complete reset
    }
  }

  // === STATIC INJECTION: Team memory (PAST sessions only) ===
  // Cached per session - identical across all requests for cache preservation

  // GLOBAL cache: same team memory for ALL requests (regardless of sessionId changes)
  // Only recalculate on: first request ever, CLEAR/Summary, project change, proxy restart
  const isSameProject = globalTeamMemoryCache?.projectPath === sessionInfo.projectPath;

  if (globalTeamMemoryCache && isSameProject) {
    // Reuse GLOBAL cached team memory (constant for entire conversation)
    (modified as Record<string, unknown>).__grovInjection = globalTeamMemoryCache.content;
    (modified as Record<string, unknown>).__grovInjectionCached = true;
    console.log(`[CACHE] Using global team memory cache, size=${globalTeamMemoryCache.content.length}`);
  } else {
    // First request OR project changed OR cache was invalidated: compute team memory
    const mentionedFiles = extractFilesFromMessages(modified.messages || []);
    const userPrompt = extractLastUserPrompt(modified.messages || []);

    // Use cloud-first approach if sync is enabled
    let teamContext: string | null = null;
    const teamId = getSyncTeamId();

    if (isSyncEnabled() && teamId) {
      console.log(`[INJECT] First/cache miss: Using cloud team memory (teamId=${teamId.substring(0, 8)}...)`);
      teamContext = await buildTeamMemoryContextCloud(
        teamId,
        sessionInfo.projectPath,
        mentionedFiles,
        userPrompt  // For hybrid semantic search
      );
    } else {
      // Sync not enabled - no injection (cloud-first approach)
      console.log('[INJECT] Sync not enabled. Enable sync for team memory injection.');
      teamContext = null;
    }

    console.log(`[CACHE] Computing team memory (first/new), files=${mentionedFiles.length}, result=${teamContext ? teamContext.length : 'null'}`);

    if (teamContext) {
      (modified as Record<string, unknown>).__grovInjection = teamContext;
      (modified as Record<string, unknown>).__grovInjectionCached = false;
      // Store in GLOBAL cache - stays constant until CLEAR or restart
      setTeamMemoryCache(sessionInfo.projectPath, teamContext);
    } else {
      // No team memory available - clear global cache for this project
      if (isSameProject) {
        invalidateTeamMemoryCache();
      }
    }
  }

  // SKIP dynamic injection for retries and continuations
  if (requestType !== 'first') {
    return modified;
  }

  // === DYNAMIC INJECTION: User message (delta only) ===
  // Includes: edited files, key decisions, drift correction, forced recovery
  // This goes into the LAST user message, not system prompt

  const dynamicInjection = buildDynamicInjection(sessionInfo.sessionId, sessionState, logger);

  if (dynamicInjection) {
    (modified as Record<string, unknown>).__grovUserMsgInjection = dynamicInjection;
    logger.info({ msg: 'Dynamic injection ready for user message', size: dynamicInjection.length });

    // Clear pending corrections after building injection
    if (sessionState?.pending_correction || sessionState?.pending_forced_recovery) {
      updateSessionState(sessionInfo.sessionId, {
        pending_correction: undefined,
        pending_forced_recovery: undefined,
      });
    }
  }

  return modified;
}
