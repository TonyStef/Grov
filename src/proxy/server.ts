// Grov Proxy Server - Fastify + undici
// Intercepts Claude Code <-> Anthropic API traffic for drift detection and context injection

import { createHash } from 'crypto';
import Fastify, { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { config, maskSensitiveValue, buildSafeHeaders } from './config.js';
import { forwardToAnthropic, isForwardError } from './forwarder.js';
import { extendedCache, evictOldestCacheEntry, checkExtendedCache, log } from './extended-cache.js';
import { setDebugMode, getNextRequestId, taskLog, proxyLog, logTokenUsage } from './utils/logging.js';
import { detectKeyDecision, extractTextContent, extractProjectPath, extractGoalFromMessages, extractConversationHistory } from './utils/extractors.js';
import { appendToLastUserMessage, injectIntoRawBody } from './injection/injectors.js';
import { preProcessRequest, setPendingPlanClear } from './handlers/preprocess.js';
import type { MessagesRequestBody } from './types.js';
import { parseToolUseBlocks, extractTokenUsage, getAllFiles, getAllFolders } from './action-parser.js';
import type { AnthropicResponse } from './action-parser.js';
import {
  createSessionState,
  getSessionState,
  updateSessionState,
  createStep,
  updateTokenCount,
  logDriftEvent,
  getRecentSteps,
  getValidatedSteps,
  updateSessionMode,
  markWaitingForRecovery,
  incrementEscalation,
  updateLastChecked,
  markCleared,
  getActiveSessionForUser,
  deleteSessionState,
  deleteStepsForSession,
  updateRecentStepsReasoning,
  markSessionCompleted,
  getCompletedSessionForProject,
  cleanupOldCompletedSessions,
  cleanupStaleActiveSessions,
  clearStalePendingCorrections,
  cleanupFailedSyncTasks,
  getKeyDecisions,
  getEditedFiles,
  type SessionState,
  type TaskType,
} from '../lib/store.js';
import {
  checkDrift,
  scoreToCorrectionLevel,
  shouldSkipSteps,
  isDriftCheckAvailable,
  checkRecoveryAlignment,
  generateForcedRecovery,
  type DriftCheckResult,
} from '../lib/drift-checker-proxy.js';
import { buildCorrection, formatCorrectionForInjection } from '../lib/correction-builder-proxy.js';
import {
  generateSessionSummary,
  isSummaryAvailable,
  extractIntent,
  isIntentExtractionAvailable,
  analyzeTaskContext,
  isTaskAnalysisAvailable,
  extractReasoningAndDecisions,
  isReasoningExtractionAvailable,
  type TaskAnalysis,
  type ConversationMessage,
} from '../lib/llm-extractor.js';
import { saveToTeamMemory, cleanupSession } from './response-processor.js';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

// Store last drift result for recovery alignment check
const lastDriftResults = new Map<string, DriftCheckResult>();

// Server logger reference (set in startServer)
let serverLog: { info: (msg: string | object) => void } | null = null;

// Track last messageCount per session to detect retries vs new turns
const lastMessageCount = new Map<string, number>();

// Session tracking (in-memory for active sessions)
const activeSessions = new Map<string, {
  sessionId: string;
  promptCount: number;
  projectPath: string;
}>();

/**
 * Create and configure the Fastify server
 */
export function createServer(): FastifyInstance {
  const fastify = Fastify({
    logger: false,  // Disabled - all debug goes to ~/.grov/debug.log
    bodyLimit: config.BODY_LIMIT,
  });

  // Custom JSON parser that preserves raw bytes for cache preservation
  fastify.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    // Store raw bytes on request for later use
    (req as unknown as { rawBody: Buffer }).rawBody = body as Buffer;
    try {
      const json = JSON.parse((body as Buffer).toString('utf-8'));
      done(null, json);
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  // Health check endpoint
  fastify.get('/health', async () => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });

  // Main messages endpoint
  fastify.post('/v1/messages', handleMessages);

  // Catch-all for other Anthropic endpoints (pass through)
  fastify.all('/*', async (request, reply) => {
    fastify.log.warn(`Unhandled endpoint: ${request.method} ${request.url}`);
    return reply.status(404).send({ error: 'Not found' });
  });

  return fastify;
}

/**
 * Handle /v1/messages requests
 */
async function handleMessages(
  request: FastifyRequest<{ Body: MessagesRequestBody }>,
  reply: FastifyReply
): Promise<void> {
  const logger = request.log;
  const startTime = Date.now();
  const model = request.body.model;

  if (model.includes('haiku')) {
    logger.info({ msg: 'Skipping Haiku subagent', model });

    try {
      // Force non-streaming for Haiku too
      const haikusBody = { ...request.body, stream: false };
      const result = await forwardToAnthropic(
        haikusBody,
        request.headers as Record<string, string | string[] | undefined>,
        logger
      );

      return reply
        .status(result.statusCode)
        .header('content-type', 'application/json')
        .headers(filterResponseHeaders(result.headers))
        .send(JSON.stringify(result.body));
    } catch (error) {
      logger.error({ msg: 'Haiku forward error', error: String(error) });
      return reply
        .status(502)
        .header('content-type', 'application/json')
        .send(JSON.stringify({ error: { type: 'proxy_error', message: 'Bad gateway' } }));
    }
  }

  // === MAIN MODEL TRACKING (Opus/Sonnet) ===

  // Get or create session (async for intent extraction)
  const sessionInfo = await getOrCreateSession(request, logger);
  sessionInfo.promptCount++;
  // Update in-memory map
  activeSessions.set(sessionInfo.sessionId, {
    sessionId: sessionInfo.sessionId,
    promptCount: sessionInfo.promptCount,
    projectPath: sessionInfo.projectPath,
  });

  const currentRequestId = getNextRequestId();

  logger.info({
    msg: 'Incoming request',
    sessionId: sessionInfo.sessionId.substring(0, 8),
    promptCount: sessionInfo.promptCount,
    model: request.body.model,
    messageCount: request.body.messages?.length || 0,
  });

  // Log REQUEST to file
  const rawBodySize = (request as unknown as { rawBody?: Buffer }).rawBody?.length || 0;
  proxyLog({
    requestId: currentRequestId,
    type: 'REQUEST',
    sessionId: sessionInfo.sessionId.substring(0, 8),
    data: {
      model: request.body.model,
      messageCount: request.body.messages?.length || 0,
      promptCount: sessionInfo.promptCount,
      rawBodySize,
    },
  });

  // Process request to get injection text
  // __grovInjection = team memory (system prompt, cached)
  // __grovUserMsgInjection = dynamic content (user message, delta only)
  const processedBody = await preProcessRequest(request.body, sessionInfo, logger, detectRequestType);
  const systemInjection = (processedBody as Record<string, unknown>).__grovInjection as string | undefined;
  const userMsgInjection = (processedBody as Record<string, unknown>).__grovUserMsgInjection as string | undefined;

  // Get raw body bytes
  const rawBody = (request as unknown as { rawBody?: Buffer }).rawBody;
  let rawBodyStr = rawBody?.toString('utf-8') || '';

  // Track injection sizes for logging
  let systemInjectionSize = 0;
  let userMsgInjectionSize = 0;
  let systemSuccess = false;
  let userMsgSuccess = false;

  // 1. Inject team memory into SYSTEM prompt (cached, constant)
  if (systemInjection && rawBodyStr) {
    const result = injectIntoRawBody(rawBodyStr, '\n\n' + systemInjection);
    rawBodyStr = result.modified;
    systemInjectionSize = systemInjection.length;
    systemSuccess = result.success;
  }

  // 2. Inject dynamic content into LAST USER MESSAGE (delta only)
  if (userMsgInjection && rawBodyStr) {
    rawBodyStr = appendToLastUserMessage(rawBodyStr, userMsgInjection);
    userMsgInjectionSize = userMsgInjection.length;
    userMsgSuccess = true;  // appendToLastUserMessage doesn't return success flag
  }

  // Determine final body to send
  let finalBodyToSend: string | Buffer;

  if (systemInjection || userMsgInjection) {
    finalBodyToSend = rawBodyStr;

    // Log INJECTION to file with full details
    const wasCached = (processedBody as Record<string, unknown>).__grovInjectionCached as boolean;
    proxyLog({
      requestId: currentRequestId,
      type: 'INJECTION',
      sessionId: sessionInfo.sessionId.substring(0, 8),
      data: {
        systemInjectionSize,
        userMsgInjectionSize,
        totalInjectionSize: systemInjectionSize + userMsgInjectionSize,
        originalSize: rawBody?.length || 0,
        finalSize: rawBodyStr.length,
        systemSuccess,
        userMsgSuccess,
        teamMemoryCached: wasCached,
        // Include actual content for debugging (truncated for log readability)
        systemInjectionPreview: systemInjection ? systemInjection.substring(0, 200) + (systemInjection.length > 200 ? '...' : '') : null,
        userMsgInjectionContent: userMsgInjection || null,  // Full content since it's small
      },
    });
  } else if (rawBody) {
    // No injection, use original raw bytes
    finalBodyToSend = rawBody;
  } else {
    // Fallback to re-serialization (shouldn't happen normally)
    finalBodyToSend = JSON.stringify(processedBody);
  }

  const forwardStart = Date.now();
  try {
    // Forward: raw bytes (with injection inserted) or original raw bytes
    const result = await forwardToAnthropic(
      processedBody,
      request.headers as Record<string, string | string[] | undefined>,
      logger,
      typeof finalBodyToSend === 'string' ? Buffer.from(finalBodyToSend, 'utf-8') : finalBodyToSend
    );
    const forwardLatency = Date.now() - forwardStart;

    // FIRE-AND-FORGET: Don't block response to Claude Code
    // This prevents retry loops caused by Haiku calls adding latency
    if (result.statusCode === 200 && isAnthropicResponse(result.body)) {
      // Prepare extended cache data (only if enabled)
      const extendedCacheData = config.EXTENDED_CACHE_ENABLED ? {
        headers: buildSafeHeaders(request.headers as Record<string, string | string[] | undefined>),
        rawBody: typeof finalBodyToSend === 'string' ? Buffer.from(finalBodyToSend, 'utf-8') : finalBodyToSend,
      } : undefined;

      postProcessResponse(result.body, sessionInfo, request.body, logger, extendedCacheData)
        .catch(err => console.error('[GROV] postProcess error:', err));
    }

    const latency = Date.now() - startTime;
    const filteredHeaders = filterResponseHeaders(result.headers);

    // Log token usage (always to console, file only in debug mode)
    if (isAnthropicResponse(result.body)) {
      const usage = extractTokenUsage(result.body);

      // Console: compact token summary (always shown)
      logTokenUsage(currentRequestId, usage, latency);

      // File: detailed response log (debug mode only)
      proxyLog({
        requestId: currentRequestId,
        type: 'RESPONSE',
        sessionId: sessionInfo.sessionId.substring(0, 8),
        data: {
          statusCode: result.statusCode,
          latencyMs: latency,
          forwardLatencyMs: forwardLatency,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheCreation: usage.cacheCreation,
          cacheRead: usage.cacheRead,
          cacheHitRatio: usage.cacheRead > 0 ? (usage.cacheRead / (usage.cacheRead + usage.cacheCreation)).toFixed(2) : '0.00',
          wasSSE: result.wasSSE,
        },
      });
    }

    // If response was SSE, forward raw SSE to Claude Code (it expects streaming)
    // Otherwise, send JSON
    const isSSEResponse = result.wasSSE;
    const responseContentType = isSSEResponse ? 'text/event-stream; charset=utf-8' : 'application/json';
    const responseBody = isSSEResponse ? result.rawBody : JSON.stringify(result.body);

    logger.info({
      msg: 'Request complete',
      statusCode: result.statusCode,
      latencyMs: latency,
      wasSSE: isSSEResponse,
    });

    return reply
      .status(result.statusCode)
      .header('content-type', responseContentType)
      .headers(filteredHeaders)
      .send(responseBody);

  } catch (error) {
    if (isForwardError(error)) {
      logger.error({
        msg: 'Forward error',
        type: error.type,
        message: error.message,
      });

      return reply
        .status(error.statusCode || 502)
        .header('content-type', 'application/json')
        .send(JSON.stringify({
          error: {
            type: 'proxy_error',
            message: error.type === 'timeout' ? 'Gateway timeout' : 'Bad gateway',
          },
        }));
    }

    logger.error({
      msg: 'Unexpected error',
      error: String(error),
    });

    return reply
      .status(500)
      .header('content-type', 'application/json')
      .send(JSON.stringify({
        error: {
          type: 'internal_error',
          message: 'Internal proxy error',
        },
      }));
  }
}

/**
 * Get or create session info for this request
 */
async function getOrCreateSession(
  request: FastifyRequest<{ Body: MessagesRequestBody }>,
  logger: { info: (data: Record<string, unknown>) => void }
): Promise<{ sessionId: string; promptCount: number; projectPath: string; isNew: boolean; currentSession: SessionState | null; completedSession: SessionState | null }> {
  // Determine project path from request
  const projectPath = extractProjectPath(request.body) || process.cwd();

  // Try to find existing active session for this project
  // Task orchestration will happen in postProcessResponse using analyzeTaskContext
  const existingSession = getActiveSessionForUser(projectPath);

  if (existingSession) {
    // Found active session - will be validated by task orchestration later
    let sessionInfo = activeSessions.get(existingSession.session_id);

    if (!sessionInfo) {
      sessionInfo = {
        sessionId: existingSession.session_id,
        promptCount: 0,
        projectPath,
      };
      activeSessions.set(existingSession.session_id, sessionInfo);
    }

    logger.info({
      msg: 'Found existing session',
      sessionId: existingSession.session_id.substring(0, 8),
      goal: existingSession.original_goal?.substring(0, 50),
    });

    return { ...sessionInfo, isNew: false, currentSession: existingSession, completedSession: null };
  }

  // No active session - check for recently completed session (for new_task detection)
  const completedSession = getCompletedSessionForProject(projectPath);
  if (completedSession) {
    logger.info({
      msg: 'Found recently completed session for comparison',
      sessionId: completedSession.session_id.substring(0, 8),
      goal: completedSession.original_goal?.substring(0, 50),
    });
  }

  // No existing session - create placeholder, real session will be created in postProcessResponse
  const tempSessionId = randomUUID();
  const sessionInfo = {
    sessionId: tempSessionId,
    promptCount: 0,
    projectPath,
  };
  activeSessions.set(tempSessionId, sessionInfo);

  // Note: team memory is now GLOBAL (not per session), no propagation needed

  logger.info({ msg: 'No existing session, will create after task analysis' });

  return { ...sessionInfo, isNew: true, currentSession: null, completedSession };
}

/**
 * Detect request type: 'first', 'continuation', or 'retry'
 * - first: new user message (messageCount changed, last msg is user without tool_result)
 * - continuation: tool result (messageCount changed, last msg has tool_result)
 * - retry: same messageCount as before
 */
function detectRequestType(
  messages: Array<{ role: string; content: unknown }>,
  projectPath: string
): 'first' | 'continuation' | 'retry' {
  const currentCount = messages?.length || 0;
  const lastCount = lastMessageCount.get(projectPath);
  lastMessageCount.set(projectPath, currentCount);

  // Same messageCount = retry
  if (lastCount !== undefined && currentCount === lastCount) {
    return 'retry';
  }

  // No messages or no last message = first
  if (!messages || messages.length === 0) return 'first';

  const lastMessage = messages[messages.length - 1];

  // Check if last message is tool_result (continuation)
  if (lastMessage.role === 'user') {
    const content = lastMessage.content;
    if (Array.isArray(content)) {
      const hasToolResult = content.some(
        (block: unknown) => typeof block === 'object' && block !== null && (block as Record<string, unknown>).type === 'tool_result'
      );
      if (hasToolResult) return 'continuation';
    }
  }

  return 'first';
}

/**
 * Post-process response after receiving from Anthropic
 * - Task orchestration (new/continue/subtask/complete)
 * - Parse tool_use blocks
 * - Update token count
 * - Save step to DB
 * - Drift check (every N prompts)
 * - Recovery alignment check (Section 4.4)
 * - Team memory triggers (Section 4.6)
 */
async function postProcessResponse(
  response: AnthropicResponse,
  sessionInfo: { sessionId: string; promptCount: number; projectPath: string; currentSession: SessionState | null; completedSession: SessionState | null },
  requestBody: MessagesRequestBody,
  logger: { info: (data: Record<string, unknown>) => void },
  extendedCacheData?: { headers: Record<string, string>; rawBody: Buffer }
): Promise<void> {
  // Parse tool_use blocks
  const actions = parseToolUseBlocks(response);

  // Extract text content for analysis
  const textContent = extractTextContent(response);

  // Extract latest user message from request
  const latestUserMessage = extractGoalFromMessages(requestBody.messages) || '';

  // Get recent steps for context
  const recentSteps = sessionInfo.currentSession
    ? getRecentSteps(sessionInfo.currentSession.session_id, 5)
    : [];

  // === TASK ORCHESTRATION (Part 8) ===
  let activeSessionId = sessionInfo.sessionId;
  let activeSession = sessionInfo.currentSession;

  // Only run task orchestration on end_turn (when Claude finishes responding to user)
  // This reduces Haiku calls from ~11 per prompt to ~1-2
  const isEndTurn = response.stop_reason === 'end_turn';

  // Skip Warmup messages (Claude Code internal initialization)
  const isWarmup = latestUserMessage.toLowerCase().trim() === 'warmup';
  if (isWarmup) {
    return;
  }

  // === EXTENDED CACHE: Capture for keep-alive ===
  // Only capture on end_turn (user idle starts now, not during tool_use loops)
  if (isEndTurn && extendedCacheData) {
    const rawStr = extendedCacheData.rawBody.toString('utf-8');
    const hasSystem = rawStr.includes('"system"');
    const hasTools = rawStr.includes('"tools"');
    const hasCacheCtrl = rawStr.includes('"cache_control"');
    const msgMatch = rawStr.match(/"messages"\s*:\s*\[/);
    const msgPos = msgMatch?.index ?? -1;

    // Use projectPath as key (one entry per conversation, not per task)
    const cacheKey = sessionInfo.projectPath;

    // Evict oldest if at capacity (only for NEW entries, not updates)
    if (!extendedCache.has(cacheKey)) {
      evictOldestCacheEntry();
    }

    extendedCache.set(cacheKey, {
      headers: extendedCacheData.headers,
      rawBody: extendedCacheData.rawBody,
      timestamp: Date.now(),
      keepAliveCount: 0,
    });
    // Cache entry captured silently
  }

  // If not end_turn (tool_use in progress), skip task orchestration but keep session
  if (!isEndTurn) {
    // Use existing session or create minimal one without LLM calls
    if (sessionInfo.currentSession) {
      activeSessionId = sessionInfo.currentSession.session_id;
      activeSession = sessionInfo.currentSession;
    } else if (!activeSession) {
      // First request, create session without task analysis
      // NOTE: Don't set original_goal to user prompt - let analyzeTaskContext synthesize it
      const newSessionId = randomUUID();
      activeSession = createSessionState({
        session_id: newSessionId,
        project_path: sessionInfo.projectPath,
        original_goal: '',  // Empty - will be synthesized by analyzeTaskContext later
        raw_user_prompt: latestUserMessage.substring(0, 500),
        task_type: 'main',
      });
      activeSessionId = newSessionId;
      activeSessions.set(newSessionId, {
        sessionId: newSessionId,
        promptCount: 1,
        projectPath: sessionInfo.projectPath,
      });

      // Note: team memory is now GLOBAL (not per session), no propagation needed
    }
  } else if (isTaskAnalysisAvailable()) {
    // Use completed session for comparison if no active session
    const sessionForComparison = sessionInfo.currentSession || sessionInfo.completedSession;
    // Extract conversation history for context-aware task analysis
    const conversationHistory = extractConversationHistory(requestBody.messages || []);
    try {
      const taskAnalysis = await analyzeTaskContext(
        sessionForComparison,
        latestUserMessage,
        recentSteps,
        textContent,
        conversationHistory
      );

      logger.info({
        msg: 'Task analysis',
        action: taskAnalysis.action,
        task_type: taskAnalysis.task_type,
        goal: taskAnalysis.current_goal?.substring(0, 50),
        reasoning: taskAnalysis.reasoning,
      });

      // TASK LOG: Analysis result
      taskLog('TASK_ANALYSIS', {
        sessionId: sessionInfo.sessionId,
        action: taskAnalysis.action,
        task_type: taskAnalysis.task_type,
        goal: taskAnalysis.current_goal || '',
        reasoning: taskAnalysis.reasoning || '',
        userMessage: latestUserMessage.substring(0, 80),
        hasCurrentSession: !!sessionInfo.currentSession,
        hasCompletedSession: !!sessionInfo.completedSession,
      });

      // Update recent steps with reasoning (backfill from end_turn response)
      if (taskAnalysis.step_reasoning && activeSessionId) {
        const updatedCount = updateRecentStepsReasoning(activeSessionId, taskAnalysis.step_reasoning);

        // TASK LOG: Step reasoning update
        taskLog('STEP_REASONING', {
          sessionId: activeSessionId,
          stepsUpdated: updatedCount,
          reasoningEntries: Object.keys(taskAnalysis.step_reasoning).length,
          stepIds: Object.keys(taskAnalysis.step_reasoning).join(','),
        });
      }

      // Handle task orchestration based on analysis
      switch (taskAnalysis.action) {
        case 'continue':
          // Use existing session or reactivate completed session
          if (sessionInfo.currentSession) {
            activeSessionId = sessionInfo.currentSession.session_id;
            activeSession = sessionInfo.currentSession;

            // Update goal if Haiku detected a new instruction from user
            // (same task/topic, but new specific instruction)
            if (taskAnalysis.current_goal &&
                taskAnalysis.current_goal !== activeSession.original_goal &&
                latestUserMessage.length > 30) {
              updateSessionState(activeSessionId, {
                original_goal: taskAnalysis.current_goal,
              });
              activeSession.original_goal = taskAnalysis.current_goal;
            }
            // TASK LOG: Continue existing session
            taskLog('ORCHESTRATION_CONTINUE', {
              sessionId: activeSessionId,
              source: 'current_session',
              goal: activeSession.original_goal,
              goalUpdated: taskAnalysis.current_goal !== activeSession.original_goal,
            });
          } else if (sessionInfo.completedSession) {
            // Reactivate completed session (user wants to continue/add to it)
            activeSessionId = sessionInfo.completedSession.session_id;
            activeSession = sessionInfo.completedSession;
            updateSessionState(activeSessionId, {
              status: 'active',
              original_goal: taskAnalysis.current_goal || activeSession.original_goal,
            });
            activeSession.status = 'active';
            activeSessions.set(activeSessionId, {
              sessionId: activeSessionId,
              promptCount: 1,
              projectPath: sessionInfo.projectPath,
            });

            // Note: team memory is now GLOBAL (not per session), no propagation needed

            // TASK LOG: Reactivate completed session
            taskLog('ORCHESTRATION_CONTINUE', {
              sessionId: activeSessionId,
              source: 'reactivated_completed',
              goal: activeSession.original_goal,
            });
          }
          break;

        case 'new_task': {
          // Clean up completed session if it exists (it was kept for comparison)
          if (sessionInfo.completedSession) {
            deleteStepsForSession(sessionInfo.completedSession.session_id);
            deleteSessionState(sessionInfo.completedSession.session_id);
          }

          // Extract full intent for new task (goal, scope, constraints, keywords)
          let intentData = {
            goal: taskAnalysis.current_goal,
            expected_scope: [] as string[],
            constraints: [] as string[],
            keywords: [] as string[],
          };
          if (isIntentExtractionAvailable() && latestUserMessage.length > 10) {
            try {
              intentData = await extractIntent(latestUserMessage);
              logger.info({ msg: 'Intent extracted for new task', scopeCount: intentData.expected_scope.length });

              // TASK LOG: Intent extraction for new_task
              taskLog('INTENT_EXTRACTION', {
                sessionId: sessionInfo.sessionId,
                context: 'new_task',
                goal: intentData.goal,
                scopeCount: intentData.expected_scope.length,
                scope: intentData.expected_scope.join(', '),
                constraints: intentData.constraints.join(', '),
                keywords: intentData.keywords.join(', '),
              });
            } catch (err) {
              logger.info({ msg: 'Intent extraction failed, using basic goal', error: String(err) });
              taskLog('INTENT_EXTRACTION_FAILED', {
                sessionId: sessionInfo.sessionId,
                context: 'new_task',
                error: String(err),
              });
            }
          }

          const newSessionId = randomUUID();
          activeSession = createSessionState({
            session_id: newSessionId,
            project_path: sessionInfo.projectPath,
            original_goal: intentData.goal,
            raw_user_prompt: latestUserMessage.substring(0, 500),
            expected_scope: intentData.expected_scope,
            constraints: intentData.constraints,
            keywords: intentData.keywords,
            task_type: 'main',
          });
          activeSessionId = newSessionId;
          activeSessions.set(newSessionId, {
            sessionId: newSessionId,
            promptCount: 1,
            projectPath: sessionInfo.projectPath,
          });
          logger.info({ msg: 'Created new task session', sessionId: newSessionId.substring(0, 8) });

          // TASK LOG: New task created
          taskLog('ORCHESTRATION_NEW_TASK', {
            sessionId: newSessionId,
            goal: intentData.goal,
            scopeCount: intentData.expected_scope.length,
            keywordsCount: intentData.keywords.length,
          });

          // Q&A AUTO-SAVE: If this is an information request with a substantive answer
          // AND no tool calls, save immediately since pure Q&A completes in a single turn.
          // If there ARE tool calls (e.g., Read for "Analyze X"), wait for them to complete
          // so steps get captured properly before saving.
          if (taskAnalysis.task_type === 'information' && textContent.length > 100 && actions.length === 0) {
            logger.info({ msg: 'Q&A detected (pure text) - saving immediately', sessionId: newSessionId.substring(0, 8) });
            taskLog('QA_AUTO_SAVE', {
              sessionId: newSessionId,
              goal: intentData.goal,
              responseLength: textContent.length,
              toolCalls: 0,
            });

            // Store the response for reasoning extraction
            updateSessionState(newSessionId, {
              final_response: textContent.substring(0, 10000),
            });

            // Save to team memory and mark complete
            await saveToTeamMemory(newSessionId, 'complete', taskAnalysis.task_type);
            markSessionCompleted(newSessionId);
          } else if (taskAnalysis.task_type === 'information' && actions.length > 0) {
            // Q&A with tool calls - don't auto-save, let it continue until task_complete
            logger.info({ msg: 'Q&A with tool calls - waiting for completion', sessionId: newSessionId.substring(0, 8), toolCalls: actions.length });
            taskLog('QA_DEFERRED', {
              sessionId: newSessionId,
              goal: intentData.goal,
              toolCalls: actions.length,
            });
          }
          break;
        }

        case 'subtask': {
          // Extract intent for subtask
          let intentData = {
            goal: taskAnalysis.current_goal,
            expected_scope: [] as string[],
            constraints: [] as string[],
            keywords: [] as string[],
          };
          if (isIntentExtractionAvailable() && latestUserMessage.length > 10) {
            try {
              intentData = await extractIntent(latestUserMessage);
              taskLog('INTENT_EXTRACTION', {
                sessionId: sessionInfo.sessionId,
                context: 'subtask',
                goal: intentData.goal,
                scope: intentData.expected_scope.join(', '),
                keywords: intentData.keywords.join(', '),
              });
            } catch (err) {
              taskLog('INTENT_EXTRACTION_FAILED', { sessionId: sessionInfo.sessionId, context: 'subtask', error: String(err) });
            }
          }

          const parentId = sessionInfo.currentSession?.session_id || taskAnalysis.parent_task_id;
          const subtaskId = randomUUID();
          activeSession = createSessionState({
            session_id: subtaskId,
            project_path: sessionInfo.projectPath,
            original_goal: intentData.goal,
            raw_user_prompt: latestUserMessage.substring(0, 500),
            expected_scope: intentData.expected_scope,
            constraints: intentData.constraints,
            keywords: intentData.keywords,
            task_type: 'subtask',
            parent_session_id: parentId,
          });
          activeSessionId = subtaskId;
          activeSessions.set(subtaskId, {
            sessionId: subtaskId,
            promptCount: 1,
            projectPath: sessionInfo.projectPath,
          });
          logger.info({ msg: 'Created subtask session', sessionId: subtaskId.substring(0, 8), parent: parentId?.substring(0, 8) });

          // TASK LOG: Subtask created
          taskLog('ORCHESTRATION_SUBTASK', {
            sessionId: subtaskId,
            parentId: parentId || 'none',
            goal: intentData.goal,
          });
          break;
        }

        case 'parallel_task': {
          // Extract intent for parallel task
          let intentData = {
            goal: taskAnalysis.current_goal,
            expected_scope: [] as string[],
            constraints: [] as string[],
            keywords: [] as string[],
          };
          if (isIntentExtractionAvailable() && latestUserMessage.length > 10) {
            try {
              intentData = await extractIntent(latestUserMessage);
              taskLog('INTENT_EXTRACTION', {
                sessionId: sessionInfo.sessionId,
                context: 'parallel_task',
                goal: intentData.goal,
                scope: intentData.expected_scope.join(', '),
                keywords: intentData.keywords.join(', '),
              });
            } catch (err) {
              taskLog('INTENT_EXTRACTION_FAILED', { sessionId: sessionInfo.sessionId, context: 'parallel_task', error: String(err) });
            }
          }

          const parentId = sessionInfo.currentSession?.session_id || taskAnalysis.parent_task_id;
          const parallelId = randomUUID();
          activeSession = createSessionState({
            session_id: parallelId,
            project_path: sessionInfo.projectPath,
            original_goal: intentData.goal,
            raw_user_prompt: latestUserMessage.substring(0, 500),
            expected_scope: intentData.expected_scope,
            constraints: intentData.constraints,
            keywords: intentData.keywords,
            task_type: 'parallel',
            parent_session_id: parentId,
          });
          activeSessionId = parallelId;
          activeSessions.set(parallelId, {
            sessionId: parallelId,
            promptCount: 1,
            projectPath: sessionInfo.projectPath,
          });
          logger.info({ msg: 'Created parallel task session', sessionId: parallelId.substring(0, 8), parent: parentId?.substring(0, 8) });

          // TASK LOG: Parallel task created
          taskLog('ORCHESTRATION_PARALLEL', {
            sessionId: parallelId,
            parentId: parentId || 'none',
            goal: intentData.goal,
          });
          break;
        }

        case 'task_complete': {
          // Save to team memory and mark as completed (don't delete yet - keep for new_task detection)
          if (sessionInfo.currentSession) {
            try {
              // Update goal if Haiku synthesized one and current is empty
              if (taskAnalysis.current_goal && !sessionInfo.currentSession.original_goal) {
                updateSessionState(sessionInfo.currentSession.session_id, {
                  original_goal: taskAnalysis.current_goal,
                });
                sessionInfo.currentSession.original_goal = taskAnalysis.current_goal;
              }

              // Set final_response BEFORE saving so reasoning extraction has the data
              updateSessionState(sessionInfo.currentSession.session_id, {
                final_response: textContent.substring(0, 10000),
              });

              await saveToTeamMemory(sessionInfo.currentSession.session_id, 'complete', taskAnalysis.task_type);
              markSessionCompleted(sessionInfo.currentSession.session_id);
              activeSessions.delete(sessionInfo.currentSession.session_id);
              lastDriftResults.delete(sessionInfo.currentSession.session_id);

              // TASK LOG: Task completed
              taskLog('ORCHESTRATION_TASK_COMPLETE', {
                sessionId: sessionInfo.currentSession.session_id,
                goal: sessionInfo.currentSession.original_goal,
              });

              // PLANNING COMPLETE: Trigger CLEAR-like reset for implementation phase
              // This ensures next request starts fresh with planning context from team memory
              if (taskAnalysis.task_type === 'planning' && isSummaryAvailable()) {
                try {
                  const allSteps = getValidatedSteps(sessionInfo.currentSession.session_id);
                  const planSummary = await generateSessionSummary(sessionInfo.currentSession, allSteps, 2000);

                  // Store for next request to trigger CLEAR
                  setPendingPlanClear({
                    projectPath: sessionInfo.projectPath,
                    summary: planSummary,
                  });

                  // Cache invalidation happens in response-processor.ts after syncTask completes

                  logger.info({
                    msg: 'PLANNING_CLEAR triggered',
                    sessionId: sessionInfo.currentSession.session_id.substring(0, 8),
                    summaryLen: planSummary.length,
                  });
                } catch {
                  // Silent fail - planning CLEAR is optional enhancement
                }
              }

              logger.info({ msg: 'Task complete - saved to team memory, marked completed' });
            } catch (err) {
              logger.info({ msg: 'Failed to save completed task', error: String(err) });
            }
          } else if (textContent.length > 100) {
            // NEW: Handle "instant complete" - task that's new AND immediately complete
            // This happens for simple Q&A when Haiku says task_complete without existing session
            // Example: user asks clarification question, answer is provided in single turn
            try {
              const newSessionId = randomUUID();
              const instantSession = createSessionState({
                session_id: newSessionId,
                project_path: sessionInfo.projectPath,
                original_goal: taskAnalysis.current_goal || '',  // Don't fallback to user prompt
                raw_user_prompt: latestUserMessage.substring(0, 500),
                task_type: 'main',
              });

              // Set final_response for reasoning extraction
              updateSessionState(newSessionId, {
                final_response: textContent.substring(0, 10000),
              });

              await saveToTeamMemory(newSessionId, 'complete', taskAnalysis.task_type);
              markSessionCompleted(newSessionId);
              logger.info({ msg: 'Instant complete - new task saved immediately', sessionId: newSessionId.substring(0, 8) });

              // TASK LOG: Instant complete (new task that finished in one turn)
              taskLog('ORCHESTRATION_TASK_COMPLETE', {
                sessionId: newSessionId,
                goal: taskAnalysis.current_goal || '',
                source: 'instant_complete',
              });
            } catch (err) {
              logger.info({ msg: 'Failed to save instant complete task', error: String(err) });
            }
          }
          return; // Done, no more processing needed
        }

        case 'subtask_complete': {
          // Save subtask and mark completed, return to parent
          if (sessionInfo.currentSession) {
            const parentId = sessionInfo.currentSession.parent_session_id;
            try {
              await saveToTeamMemory(sessionInfo.currentSession.session_id, 'complete', taskAnalysis.task_type);
              markSessionCompleted(sessionInfo.currentSession.session_id);
              activeSessions.delete(sessionInfo.currentSession.session_id);
              lastDriftResults.delete(sessionInfo.currentSession.session_id);

              // Switch to parent session
              if (parentId) {
                const parentSession = getSessionState(parentId);
                if (parentSession) {
                  activeSessionId = parentId;
                  activeSession = parentSession;
                  logger.info({ msg: 'Subtask complete - returning to parent', parent: parentId.substring(0, 8) });

                  // TASK LOG: Subtask completed
                  taskLog('ORCHESTRATION_SUBTASK_COMPLETE', {
                    sessionId: sessionInfo.currentSession.session_id,
                    parentId: parentId,
                    goal: sessionInfo.currentSession.original_goal,
                  });
                }
              }
            } catch (err) {
              logger.info({ msg: 'Failed to save completed subtask', error: String(err) });
            }
          }
          break;
        }
      }
    } catch (error) {
      logger.info({ msg: 'Task analysis failed, using existing session', error: String(error) });
      // Fall back to existing session or create new with intent extraction
      if (!sessionInfo.currentSession) {
        let intentData = {
          goal: '',  // Don't copy user prompt - let extractIntent synthesize or leave empty
          expected_scope: [] as string[],
          constraints: [] as string[],
          keywords: [] as string[],
        };
        if (isIntentExtractionAvailable() && latestUserMessage.length > 10) {
          try {
            intentData = await extractIntent(latestUserMessage);
            taskLog('INTENT_EXTRACTION', {
              sessionId: sessionInfo.sessionId,
              context: 'fallback_analysis_failed',
              goal: intentData.goal,
              scope: intentData.expected_scope.join(', '),
            });
          } catch (err) {
            taskLog('INTENT_EXTRACTION_FAILED', { sessionId: sessionInfo.sessionId, context: 'fallback_analysis_failed', error: String(err) });
          }
        }

        const newSessionId = randomUUID();
        activeSession = createSessionState({
          session_id: newSessionId,
          project_path: sessionInfo.projectPath,
          original_goal: intentData.goal,
          raw_user_prompt: latestUserMessage.substring(0, 500),
          expected_scope: intentData.expected_scope,
          constraints: intentData.constraints,
          keywords: intentData.keywords,
          task_type: 'main',
        });
        activeSessionId = newSessionId;
      }
    }
  } else {
    // No task analysis available - fallback with intent extraction
    taskLog('TASK_ANALYSIS_UNAVAILABLE', {
      sessionId: sessionInfo.sessionId,
      hasCurrentSession: !!sessionInfo.currentSession,
      userMessage: latestUserMessage.substring(0, 80),
    });

    if (!sessionInfo.currentSession) {
      let intentData = {
        goal: '',  // Don't copy user prompt - let extractIntent synthesize or leave empty
        expected_scope: [] as string[],
        constraints: [] as string[],
        keywords: [] as string[],
      };
      if (isIntentExtractionAvailable() && latestUserMessage.length > 10) {
        try {
          intentData = await extractIntent(latestUserMessage);
          logger.info({ msg: 'Intent extracted (fallback)', scopeCount: intentData.expected_scope.length });
          taskLog('INTENT_EXTRACTION', {
            sessionId: sessionInfo.sessionId,
            context: 'no_analysis_available',
            goal: intentData.goal,
            scope: intentData.expected_scope.join(', '),
          });
        } catch (err) {
          taskLog('INTENT_EXTRACTION_FAILED', { sessionId: sessionInfo.sessionId, context: 'no_analysis_available', error: String(err) });
        }
      }

      const newSessionId = randomUUID();
      activeSession = createSessionState({
        session_id: newSessionId,
        project_path: sessionInfo.projectPath,
        original_goal: intentData.goal,
        raw_user_prompt: latestUserMessage.substring(0, 500),
        expected_scope: intentData.expected_scope,
        constraints: intentData.constraints,
        keywords: intentData.keywords,
        task_type: 'main',
      });
      activeSessionId = newSessionId;
    } else {
      activeSession = sessionInfo.currentSession;
      activeSessionId = sessionInfo.currentSession.session_id;
    }
  }

  // NOTE: Auto-save on every end_turn was REMOVED
  // Task saving is now controlled by Haiku's task analysis:
  // - task_complete: Haiku detected task is done (Q&A answered, implementation verified, planning confirmed)
  // - subtask_complete: Haiku detected subtask is done
  // This ensures we only save when work is actually complete, not on every Claude response.
  // See analyzeTaskContext() in llm-extractor.ts for the decision logic.

  // Extract token usage
  const usage = extractTokenUsage(response);

  // Use cache metrics as actual context size (cacheCreation + cacheRead)
  // This is what Anthropic bills for and what determines CLEAR threshold
  const actualContextSize = usage.cacheCreation + usage.cacheRead;

  if (activeSession) {
    // Set to actual context size (not cumulative - context size IS the total)
    updateTokenCount(activeSessionId, actualContextSize);
  }

  logger.info({
    msg: 'Token usage',
    input: usage.inputTokens,
    output: usage.outputTokens,
    total: usage.totalTokens,
    cacheCreation: usage.cacheCreation,
    cacheRead: usage.cacheRead,
    actualContextSize,
    activeSession: activeSessionId.substring(0, 8),
  });

  // === CLEAR MODE PRE-COMPUTE (85% threshold) ===
  const preComputeThreshold = Math.floor(config.TOKEN_CLEAR_THRESHOLD * 0.85);

  if (activeSession &&
      actualContextSize > preComputeThreshold &&
      !activeSession.pending_clear_summary &&
      isSummaryAvailable()) {

    const allSteps = getValidatedSteps(activeSessionId);

    generateSessionSummary(activeSession, allSteps, 15000).then(summary => {
      updateSessionState(activeSessionId, { pending_clear_summary: summary });
      logger.info({
        msg: 'CLEAR summary pre-computed',
        actualContextSize,
        threshold: preComputeThreshold,
        summaryLength: summary.length,
      });
    }).catch(err => {
      logger.info({ msg: 'CLEAR summary generation failed', error: String(err) });
    });
  }

  // Capture final_response for ALL end_turn responses (not just Q&A)
  // This preserves Claude's analysis even when tools were used
  if (isEndTurn && textContent.length > 100 && activeSessionId) {
    updateSessionState(activeSessionId, {
      final_response: textContent.substring(0, 10000),
    });
  }

  if (actions.length === 0) {
    // Final response (no tool calls)
    // NOTE: Task saving is controlled by Haiku's task analysis (see switch case 'task_complete' above)
    return;
  }

  logger.info({
    msg: 'Actions parsed',
    count: actions.length,
    tools: actions.map(a => a.toolName),
  });

  // Recovery alignment check (Section 4.4)
  if (activeSession && activeSession.waiting_for_recovery) {
    const lastDrift = lastDriftResults.get(activeSessionId);
    const recoveryPlan = lastDrift?.recoverySteps ? { steps: lastDrift.recoverySteps } : undefined;

    for (const action of actions) {
      const alignment = checkRecoveryAlignment(
        { actionType: action.actionType, files: action.files, command: action.command },
        recoveryPlan,
        activeSession
      );

      if (alignment.aligned) {
        // Recovered! Reset to normal
        updateSessionMode(activeSessionId, 'normal');
        markWaitingForRecovery(activeSessionId, false);
        updateSessionState(activeSessionId, { escalation_count: 0 });
        lastDriftResults.delete(activeSessionId);

        logger.info({
          msg: 'Recovery alignment SUCCESS - resuming normal mode',
          reason: alignment.reason,
        });
      } else {
        incrementEscalation(activeSessionId);

        logger.info({
          msg: 'Recovery alignment FAILED - escalating',
          reason: alignment.reason,
          escalation: activeSession.escalation_count + 1,
        });
      }
    }
  }

  // Run drift check every N prompts (only when files are being modified)
  let driftScore: number | undefined;
  let skipSteps = false;
  const memSessionInfo = activeSessions.get(activeSessionId);
  const promptCount = memSessionInfo?.promptCount || sessionInfo.promptCount;

  // Skip drift check if no file modifications - drift detection only makes sense
  // when Claude is actually changing files, not when reading/exploring/answering questions
  const recentStepsForCheck = activeSessionId ? getRecentSteps(activeSessionId, 10) : [];
  const hasFileModifications = recentStepsForCheck.some(s =>
    s.action_type === 'edit' || s.action_type === 'write'
  );

  // Skip drift check if goal is missing or placeholder - Haiku needs context to evaluate
  const hasValidGoal = activeSession?.original_goal &&
    activeSession.original_goal.length > 10 &&
    !activeSession.original_goal.includes('the original task');

  if (hasValidGoal && hasFileModifications && promptCount % config.DRIFT_CHECK_INTERVAL === 0 && isDriftCheckAvailable()) {
    if (activeSession) {
      // Reuse recentStepsForCheck instead of calling getRecentSteps again
      const driftResult = await checkDrift({ sessionState: activeSession, recentSteps: recentStepsForCheck, latestUserMessage });

      lastDriftResults.set(activeSessionId, driftResult);

      driftScore = driftResult.score;
      skipSteps = shouldSkipSteps(driftScore);

      logger.info({
        msg: 'Drift check',
        score: driftResult.score,
        type: driftResult.driftType,
        diagnostic: driftResult.diagnostic,
      });

      const correctionLevel = scoreToCorrectionLevel(driftScore);
      const currentEscalation = activeSession.escalation_count || 0;

      // LIMIT: Stop corrections after 2 attempts - if it didn't help, give up
      // This prevents infinite correction loops from false positives
      const maxCorrectionAttempts = 2;
      const shouldCorrect = correctionLevel && currentEscalation < maxCorrectionAttempts;

      if (shouldCorrect && (correctionLevel === 'intervene' || correctionLevel === 'halt')) {
        updateSessionMode(activeSessionId, 'drifted');
        markWaitingForRecovery(activeSessionId, true);
        incrementEscalation(activeSessionId);

        // Pre-compute correction for next request (fire-and-forget pattern)
        const correction = buildCorrection(driftResult, activeSession, correctionLevel);
        const correctionText = formatCorrectionForInjection(correction);
        updateSessionState(activeSessionId, { pending_correction: correctionText });

        logger.info({
          msg: 'Pre-computed correction saved',
          level: correctionLevel,
          correctionLength: correctionText.length,
          attempt: currentEscalation + 1,
        });
      } else if (shouldCorrect && correctionLevel) {
        // Nudge or correct level - still save correction but don't change mode
        incrementEscalation(activeSessionId);
        const correction = buildCorrection(driftResult, activeSession, correctionLevel);
        const correctionText = formatCorrectionForInjection(correction);
        updateSessionState(activeSessionId, { pending_correction: correctionText });

        logger.info({
          msg: 'Pre-computed mild correction saved',
          level: correctionLevel,
          attempt: currentEscalation + 1,
        });
      } else if (currentEscalation >= maxCorrectionAttempts && correctionLevel) {
        // Max attempts reached - give up, clear correction, reset to normal
        logger.info({
          msg: 'Max correction attempts reached - giving up',
          attempts: currentEscalation,
          lastScore: driftScore,
        });
        updateSessionMode(activeSessionId, 'normal');
        markWaitingForRecovery(activeSessionId, false);
        updateSessionState(activeSessionId, {
          pending_correction: undefined,
          escalation_count: 0,
        });
      } else if (driftScore >= 5) {
        // Score OK (5-10) - reset everything, drift resolved
        updateSessionMode(activeSessionId, 'normal');
        markWaitingForRecovery(activeSessionId, false);
        lastDriftResults.delete(activeSessionId);
        // Clear correction AND reset escalation so future drift starts fresh
        updateSessionState(activeSessionId, {
          pending_correction: undefined,
          escalation_count: 0,
        });
      }

      // NOTE: Forced mode removed - we give up after maxCorrectionAttempts (2)
      // If 2 correction attempts didn't help, further escalation is unlikely to help
      // and may be a false positive. Better to stop than to keep annoying the user.

      updateLastChecked(activeSessionId, Date.now());

      if (skipSteps) {
        for (const action of actions) {
          logDriftEvent({
            session_id: activeSessionId,
            action_type: action.actionType,
            files: action.files,
            drift_score: driftScore,
            drift_reason: driftResult.diagnostic,
            recovery_plan: driftResult.recoverySteps ? { steps: driftResult.recoverySteps } : undefined,
          });
        }
        logger.info({
          msg: 'Actions logged to drift_log (skipped steps)',
          reason: 'score < 5',
        });
        return;
      }
    }
  }

  // Save each action as a step (with reasoning from Claude's text)
  // When multiple actions come from the same Claude response, they share identical reasoning.
  // We store reasoning only on the first action and set NULL for subsequent ones to avoid duplication.
  // At query time, we group steps by reasoning (non-NULL starts a group, NULLs continue it)
  // and reconstruct the full context: reasoning + all associated files/actions.
  let previousReasoning: string | null = null;

  logger.info({ msg: 'DEDUP_DEBUG', actionsCount: actions.length, textContentLen: textContent.length });

  for (const action of actions) {
    const currentReasoning = textContent.substring(0, 1000);
    const isDuplicate = currentReasoning === previousReasoning;

    logger.info({
      msg: 'DEDUP_STEP',
      actionType: action.actionType,
      isDuplicate,
      prevLen: previousReasoning?.length || 0,
      currLen: currentReasoning.length
    });

    // Detect key decisions based on action type and reasoning content
    const isKeyDecision = !isDuplicate && detectKeyDecision(action, textContent);

    createStep({
      session_id: activeSessionId,
      action_type: action.actionType,
      files: action.files,
      folders: action.folders,
      command: action.command,
      reasoning: isDuplicate ? undefined : currentReasoning,
      drift_score: driftScore,
      is_validated: !skipSteps,
      is_key_decision: isKeyDecision,
    });

    previousReasoning = currentReasoning;

    if (isKeyDecision) {
      logger.info({
        msg: 'Key decision detected',
        actionType: action.actionType,
        files: action.files.slice(0, 3),
      });
    }
  }
}

/**
 * Filter response headers for forwarding to client
 */
function filterResponseHeaders(
  headers: Record<string, string | string[]>
): Record<string, string> {
  const filtered: Record<string, string> = {};
  const allowedHeaders = [
    'content-type',
    'x-request-id',
    'request-id',
    'x-should-retry',
    'retry-after',
    'retry-after-ms',
    'anthropic-ratelimit-requests-limit',
    'anthropic-ratelimit-requests-remaining',
    'anthropic-ratelimit-requests-reset',
    'anthropic-ratelimit-tokens-limit',
    'anthropic-ratelimit-tokens-remaining',
    'anthropic-ratelimit-tokens-reset',
  ];

  for (const header of allowedHeaders) {
    const value = headers[header];
    if (value) {
      filtered[header] = Array.isArray(value) ? value[0] : value;
    }
  }

  return filtered;
}

/**
 * Type guard for AnthropicResponse
 */
function isAnthropicResponse(body: unknown): body is AnthropicResponse {
  return (
    typeof body === 'object' &&
    body !== null &&
    'type' in body &&
    (body as Record<string, unknown>).type === 'message' &&
    'content' in body &&
    'usage' in body
  );
}

/**
 * Start the proxy server
 * @param options.debug - Enable debug logging to grov-proxy.log
 */
export async function startServer(options: { debug?: boolean } = {}): Promise<FastifyInstance> {
  if (options.debug) {
    setDebugMode(true);
  }

  const server = createServer();

  // Set server logger for background tasks
  serverLog = server.log;

  // Startup cleanup
  cleanupOldCompletedSessions();
  cleanupFailedSyncTasks();

  // Cleanup stale active sessions (no activity for 1 hour)
  // Prevents old sessions from being reused in fresh Claude sessions
  const staleCount = cleanupStaleActiveSessions();
  if (staleCount > 0) {
    log(`Cleaned up ${staleCount} stale active session(s)`);
  }

  // Start extended cache timer if enabled
  let extendedCacheTimer: NodeJS.Timeout | null = null;

  // Track active connections for graceful shutdown
  const activeConnections = new Set<import('net').Socket>();
  let isShuttingDown = false;

  // Graceful shutdown handler (works with or without extended cache)
  const gracefulShutdown = () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    log('Shutdown initiated...');

    // 1. Stop extended cache timer if running
    if (extendedCacheTimer) {
      clearInterval(extendedCacheTimer);
      extendedCacheTimer = null;
    }

    // 2. Clear sensitive cache data
    if (extendedCache.size > 0) {
      for (const entry of extendedCache.values()) {
        for (const key of Object.keys(entry.headers)) {
          entry.headers[key] = '';
        }
        entry.rawBody = Buffer.alloc(0);
      }
      extendedCache.clear();
    }

    // 3. Stop accepting new connections
    server.close();

    // 4. Grace period (500ms) then force close remaining connections
    setTimeout(() => {
      if (activeConnections.size > 0) {
        log(`Force closing ${activeConnections.size} connection(s)`);
        for (const socket of activeConnections) {
          socket.destroy();
        }
      }
      log('Goodbye!');
      process.exit(0);
    }, 500);
  };

  process.on('SIGTERM', gracefulShutdown);
  process.on('SIGINT', gracefulShutdown);

  if (config.EXTENDED_CACHE_ENABLED) {
    extendedCacheTimer = setInterval(checkExtendedCache, 60_000);
    log('Extended cache: enabled (keep-alive timer started)');
  }

  // Clear stale pending corrections from previous sessions
  // Prevents stuck HALT states from blocking new sessions
  clearStalePendingCorrections();

  try {
    await server.listen({
      host: config.HOST,
      port: config.PORT,
    });

    // Track connections for graceful shutdown
    server.server.on('connection', (socket: import('net').Socket) => {
      activeConnections.add(socket);
      socket.on('close', () => activeConnections.delete(socket));
    });

    console.log(`Grov Proxy: http://${config.HOST}:${config.PORT} -> ${config.ANTHROPIC_BASE_URL}`);

    return server;
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
}

// CLI entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  startServer();
}
