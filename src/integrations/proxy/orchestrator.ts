// Grov Proxy Orchestrator - Shared business logic for all agents
// Handles session management, task orchestration, drift detection, and memory injection

import { randomUUID } from 'crypto';
import { config, buildSafeHeaders } from './config.js';
import { extendedCache, evictOldestCacheEntry } from './cache/extended-cache.js';
import { getNextRequestId, taskLog, proxyLog, logTokenUsage } from './utils/logging.js';
import { preProcessRequest, setPendingPlanClear } from './handlers/preprocess.js';
import type { AgentAdapter } from './agents/types.js';
import type { RequestHeaders } from '../../core/extraction/llm-extractor.js';
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
  getActiveSessionForUser,
  deleteSessionState,
  deleteStepsForSession,
  updateRecentStepsReasoning,
  markSessionCompleted,
  getCompletedSessionForProject,
  type SessionState,
} from '../../core/store/store.js';
import {
  checkDrift,
  scoreToCorrectionLevel,
  shouldSkipSteps,
  checkRecoveryAlignment,
  type DriftCheckResult,
} from '../../core/extraction/drift-checker-proxy.js';
import { buildCorrection, formatCorrectionForInjection } from '../../core/extraction/correction-builder-proxy.js';
import {
  generateSessionSummary,
  analyzeTaskContext,
} from '../../core/extraction/llm-extractor.js';
import { saveToTeamMemory } from './response-processor.js';
import {
  getCachedMemoryById,
  buildExpandedMemory,
  addInjectionRecord,
  hasToolCycleAtPosition,
} from './injection/memory-injection.js';

// In-memory state
const lastDriftResults = new Map<string, DriftCheckResult>();
const lastMessageCount = new Map<string, number>();
const activeSessions = new Map<string, {
  sessionId: string;
  promptCount: number;
  projectPath: string;
}>();

// Types
export interface OrchestratorResult {
  statusCode: number;
  contentType: string;
  headers: Record<string, string>;
  body: string;
}

interface SessionContext {
  sessionId: string;
  promptCount: number;
  projectPath: string;
  isNew: boolean;
  currentSession: SessionState | null;
  completedSession: SessionState | null;
}

interface RequestContext {
  adapter: AgentAdapter;
  body: unknown;
  headers: Record<string, string>;
  rawBody?: Buffer;
  logger: {
    info: (data: Record<string, unknown>) => void;
    error?: (data: Record<string, unknown>) => void;
  };
}

type DetectRequestTypeFn = (
  messages: Array<{ role: string; content: unknown }>,
  projectPath: string
) => 'first' | 'continuation' | 'retry';

/**
 * Main entry point for handling agent requests
 */
export async function handleAgentRequest(context: RequestContext): Promise<OrchestratorResult> {
  const { adapter, body, headers, rawBody, logger } = context;
  const startTime = Date.now();

  // Extract model from body
  const requestBody = body as Record<string, unknown>;
  const model = (requestBody.model as string) || '';

  // Skip subagent models (Haiku for Claude, mini for Codex)
  if (adapter.isSubagentModel(model)) {
    logger.info({ msg: 'Skipping subagent', model });

    try {
      const result = await adapter.forward(
        { ...requestBody, stream: false },
        headers,
        rawBody
      );

      return {
        statusCode: result.statusCode,
        contentType: 'application/json',
        headers: adapter.filterResponseHeaders(result.headers as Record<string, string | string[]>),
        body: JSON.stringify(result.body),
      };
    } catch (error) {
      logger.error?.({ msg: 'Subagent forward error', error: String(error) });
      return {
        statusCode: 502,
        contentType: 'application/json',
        headers: {},
        body: JSON.stringify({ error: { type: 'proxy_error', message: 'Bad gateway' } }),
      };
    }
  }

  // Get or create session
  const sessionInfo = await getOrCreateSession(adapter, body, logger);
  sessionInfo.promptCount++;

  activeSessions.set(sessionInfo.sessionId, {
    sessionId: sessionInfo.sessionId,
    promptCount: sessionInfo.promptCount,
    projectPath: sessionInfo.projectPath,
  });

  const currentRequestId = getNextRequestId();

  logger.info({
    msg: 'Incoming request',
    agent: adapter.name,
    sessionId: sessionInfo.sessionId.substring(0, 8),
    promptCount: sessionInfo.promptCount,
    model,
    messageCount: getMessageCount(body),
  });

  proxyLog({
    requestId: currentRequestId,
    type: 'REQUEST',
    sessionId: sessionInfo.sessionId.substring(0, 8),
    data: {
      agent: adapter.name,
      model,
      messageCount: getMessageCount(body),
      promptCount: sessionInfo.promptCount,
      rawBodySize: rawBody?.length || 0,
    },
  });

  // Pre-process request for memory injection (agent-agnostic)
  const processedBody = await preProcessRequest(adapter, requestBody, sessionInfo, logger, detectRequestType);
  const systemInjection = (processedBody as Record<string, unknown>).__grovInjection as string | undefined;
  const userMsgInjection = (processedBody as Record<string, unknown>).__grovUserMsgInjection as string | undefined;
  const rawUserPrompt = (processedBody as Record<string, unknown>).__grovRawUserPrompt as string;

  // Build final body with injections using adapter methods
  let rawBodyStr = rawBody?.toString('utf-8') || '';
  let systemInjectionSize = 0;
  let userMsgInjectionSize = 0;
  let systemSuccess = false;
  let userMsgSuccess = false;

  if (systemInjection && rawBodyStr) {
    const result = adapter.injectIntoRawSystemPrompt(rawBodyStr, '\n\n' + systemInjection);
    rawBodyStr = result.modified;
    systemInjectionSize = systemInjection.length;
    systemSuccess = result.success;
  }

  if (userMsgInjection && rawBodyStr) {
    const beforeLen = rawBodyStr.length;
    rawBodyStr = adapter.injectIntoRawUserMessage(rawBodyStr, userMsgInjection);
    const afterLen = rawBodyStr.length;
    userMsgInjectionSize = userMsgInjection.length;
    userMsgSuccess = afterLen > beforeLen;
  }

  // Inject grov_expand tool if needed
  const hasGrovExpandInProcessed = (processedBody as Record<string, unknown>).tools &&
    Array.isArray((processedBody as Record<string, unknown>).tools) &&
    ((processedBody as Record<string, unknown>).tools as Array<{ name?: string }>).some(
      t => t.name === 'grov_expand'
    );

  if (hasGrovExpandInProcessed && rawBodyStr) {
    const toolDef = adapter.buildGrovExpandTool();
    const result = adapter.injectToolIntoRawBody(rawBodyStr, toolDef);
    if (result.success) {
      rawBodyStr = result.modified;
    }
  }

  // Determine final body
  let finalBodyToSend: Buffer;
  const reconstructedCount = (processedBody as Record<string, unknown>).__grovReconstructedCount as number || 0;

  if (systemInjection || userMsgInjection) {
    finalBodyToSend = Buffer.from(rawBodyStr, 'utf-8');

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
        systemInjectionPreview: systemInjection ? systemInjection.substring(0, 200) + (systemInjection.length > 200 ? '...' : '') : null,
        userMsgInjectionContent: userMsgInjection || null,
      },
    });
  } else if (reconstructedCount > 0) {
    const { __grovInjection, __grovUserMsgInjection, __grovInjectionCached, __grovReconstructedCount, __grovOriginalLastUserPos, __grovRawUserPrompt: _rawPrompt1, ...cleanBody } = processedBody as Record<string, unknown>;
    finalBodyToSend = Buffer.from(JSON.stringify(cleanBody), 'utf-8');
  } else if (rawBody) {
    finalBodyToSend = rawBody;
  } else {
    finalBodyToSend = Buffer.from(JSON.stringify(processedBody), 'utf-8');
  }

  const forwardStart = Date.now();

  try {
    // Forward to upstream API
    let result = await adapter.forward(processedBody, headers, finalBodyToSend);

    // Handle grov_expand internal tool loop
    let loopCount = 0;
    const maxLoops = 5;

    while (
      result.statusCode === 200 &&
      adapter.isValidResponse(result.body) &&
      adapter.isToolUse(result.body) &&
      loopCount < maxLoops
    ) {
      const grovExpandBlock = adapter.findInternalToolUse(result.body, 'grov_expand');
      if (!grovExpandBlock) break;

      loopCount++;
      const ids = (grovExpandBlock.input as { ids?: string[] })?.ids || [];

      const expandedParts: string[] = [];
      for (const id of ids) {
        const memory = getCachedMemoryById(sessionInfo.projectPath, id);
        if (memory) {
          expandedParts.push(buildExpandedMemory(memory));
        } else {
          console.log(`[MEMORY] NOT FOUND: #${id}`);
          expandedParts.push(`Memory #${id} not found - it may be from an older conversation. Only expand IDs from the CURRENT knowledge base.`);
        }
      }

      if (ids.length > 0) {
        const expandedCount = expandedParts.filter(p => !p.includes('not found')).length;
        console.log(`[MEMORY] Expanded ${expandedCount}/${ids.length} memories`);
      }

      const toolResult = expandedParts.join('\n\n');

      const originalPos = (processedBody as Record<string, unknown>).__grovOriginalLastUserPos as number;
      const pos = originalPos ?? 0;
      if (!hasToolCycleAtPosition(sessionInfo.projectPath, pos)) {
        addInjectionRecord(sessionInfo.projectPath, {
          position: pos,
          type: 'tool_cycle',
          toolUse: { id: grovExpandBlock.id, name: 'grov_expand', input: grovExpandBlock.input },
          toolResult,
        });
      }

      // Strip internal __grov* fields before building continue body
      const { __grovInjection, __grovUserMsgInjection, __grovInjectionCached, __grovReconstructedCount, __grovOriginalLastUserPos, __grovRawUserPrompt: _rawPrompt2, ...cleanProcessedBody } = processedBody as Record<string, unknown>;
      const continueBody = adapter.buildContinueBody(
        cleanProcessedBody,
        getAssistantContent(result.body, adapter),
        toolResult,
        grovExpandBlock.id
      );

      result = await adapter.forward(continueBody, headers);
    }

    const forwardLatency = Date.now() - forwardStart;

    // Fire-and-forget post-processing
    if (result.statusCode === 200 && adapter.isValidResponse(result.body)) {
      const extendedCacheData = config.EXTENDED_CACHE_ENABLED ? {
        headers: buildSafeHeaders(headers as Record<string, string | string[] | undefined>),
        rawBody: finalBodyToSend,
      } : undefined;

      postProcessResponse(
        adapter,
        result.body,
        sessionInfo,
        processedBody,
        logger,
        extendedCacheData,
        headers
      ).catch(err => console.error('[GROV] postProcess error:', err));
    }

    const latency = Date.now() - startTime;
    const filteredHeaders = adapter.filterResponseHeaders(result.headers as Record<string, string | string[]>);

    if (adapter.isValidResponse(result.body)) {
      const usage = adapter.extractUsage(result.body);
      logTokenUsage(currentRequestId, usage, latency);

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
          grovExpandLoops: loopCount > 0 ? loopCount : undefined,
        },
      });
    }

    logger.info({
      msg: 'Request complete',
      statusCode: result.statusCode,
      latencyMs: latency,
      wasSSE: result.wasSSE,
      grovExpandLoops: loopCount > 0 ? loopCount : undefined,
    });

    return {
      statusCode: result.statusCode,
      contentType: adapter.getResponseContentType(result.wasSSE || false),
      headers: filteredHeaders,
      body: result.wasSSE ? result.rawBody : JSON.stringify(result.body),
    };

  } catch (error) {
    const err = error as { type?: string; message?: string; statusCode?: number };

    if (err.type === 'timeout' || err.type === 'network') {
      logger.error?.({
        msg: 'Forward error',
        type: err.type,
        message: err.message,
      });

      return {
        statusCode: err.statusCode || 502,
        contentType: 'application/json',
        headers: {},
        body: JSON.stringify({
          error: {
            type: 'proxy_error',
            message: err.type === 'timeout' ? 'Gateway timeout' : 'Bad gateway',
          },
        }),
      };
    }

    logger.error?.({
      msg: 'Unexpected error',
      error: String(error),
    });

    return {
      statusCode: 500,
      contentType: 'application/json',
      headers: {},
      body: JSON.stringify({
        error: {
          type: 'internal_error',
          message: 'Internal proxy error',
        },
      }),
    };
  }
}

/**
 * Get or create session for this request
 */
async function getOrCreateSession(
  adapter: AgentAdapter,
  body: unknown,
  logger: { info: (data: Record<string, unknown>) => void }
): Promise<SessionContext> {
  const projectPath = adapter.extractProjectPath(body) || process.cwd();
  const existingSession = getActiveSessionForUser(projectPath);

  if (existingSession) {
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

  const completedSession = getCompletedSessionForProject(projectPath);
  if (completedSession) {
    logger.info({
      msg: 'Found recently completed session for comparison',
      sessionId: completedSession.session_id.substring(0, 8),
      goal: completedSession.original_goal?.substring(0, 50),
    });
  }

  const tempSessionId = randomUUID();
  const sessionInfo = {
    sessionId: tempSessionId,
    promptCount: 0,
    projectPath,
  };
  activeSessions.set(tempSessionId, sessionInfo);

  logger.info({ msg: 'No existing session, will create after task analysis' });

  return { ...sessionInfo, isNew: true, currentSession: null, completedSession };
}

/**
 * Detect request type: first, continuation, or retry
 */
function detectRequestType(
  messages: Array<{ role: string; content: unknown }>,
  projectPath: string
): 'first' | 'continuation' | 'retry' {
  const currentCount = messages?.length || 0;
  const lastCount = lastMessageCount.get(projectPath);
  lastMessageCount.set(projectPath, currentCount);

  if (lastCount !== undefined && currentCount === lastCount) {
    return 'retry';
  }

  if (!messages || messages.length === 0) return 'first';

  const lastMessage = messages[messages.length - 1];

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
 * Post-process response - task orchestration, drift detection, step recording
 */
async function postProcessResponse(
  adapter: AgentAdapter,
  response: unknown,
  sessionInfo: SessionContext,
  requestBody: unknown,
  logger: { info: (data: Record<string, unknown>) => void },
  extendedCacheData: { headers: Record<string, string>; rawBody: Buffer } | undefined,
  requestHeaders: RequestHeaders
): Promise<void> {
  const actions = adapter.parseActions(response);
  const textContent = adapter.extractTextContent(response);
  const messages = getMessages(requestBody);
  const latestUserMessage = adapter.extractGoal(messages) || '';
  const rawUserPrompt = (requestBody as Record<string, unknown>).__grovRawUserPrompt as string;
  const recentSteps = sessionInfo.currentSession
    ? getRecentSteps(sessionInfo.currentSession.session_id, 5)
    : [];

  let activeSessionId = sessionInfo.sessionId;
  let activeSession = sessionInfo.currentSession;

  const isEndTurn = adapter.isEndTurn(response);
  const isWarmup = latestUserMessage.toLowerCase().trim() === 'warmup';

  if (isWarmup) {
    return;
  }

  // Extended cache capture on end_turn
  if (isEndTurn && extendedCacheData) {
    const cacheKey = sessionInfo.projectPath;

    if (!extendedCache.has(cacheKey)) {
      evictOldestCacheEntry();
    }

    extendedCache.set(cacheKey, {
      headers: extendedCacheData.headers,
      rawBody: extendedCacheData.rawBody,
      timestamp: Date.now(),
      keepAliveCount: 0,
    });
  }

  // Skip task orchestration if not end_turn
  if (!isEndTurn) {
    if (sessionInfo.currentSession) {
      activeSessionId = sessionInfo.currentSession.session_id;
      activeSession = sessionInfo.currentSession;
    } else if (!activeSession) {
      const newSessionId = randomUUID();
      activeSession = createSessionState({
        session_id: newSessionId,
        project_path: sessionInfo.projectPath,
        original_goal: '',
        raw_user_prompt: rawUserPrompt,
        task_type: 'main',
      });
      activeSessionId = newSessionId;
      activeSessions.set(newSessionId, {
        sessionId: newSessionId,
        promptCount: 1,
        projectPath: sessionInfo.projectPath,
      });
    }
  } else {
    const sessionForComparison = sessionInfo.currentSession || sessionInfo.completedSession;
    const conversationHistory = adapter.extractHistory(messages);

    try {
      const taskAnalysis = await analyzeTaskContext(
        sessionForComparison,
        latestUserMessage,
        recentSteps,
        textContent,
        conversationHistory,
        requestHeaders
      );

      logger.info({
        msg: 'Task analysis',
        action: taskAnalysis.action,
        task_type: taskAnalysis.task_type,
        goal: taskAnalysis.current_goal?.substring(0, 50),
        reasoning: taskAnalysis.reasoning,
      });

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

      if (taskAnalysis.step_reasoning && activeSessionId) {
        const updatedCount = updateRecentStepsReasoning(activeSessionId, taskAnalysis.step_reasoning);
        taskLog('STEP_REASONING', {
          sessionId: activeSessionId,
          stepsUpdated: updatedCount,
          reasoningEntries: Object.keys(taskAnalysis.step_reasoning).length,
          stepIds: Object.keys(taskAnalysis.step_reasoning).join(','),
        });
      }

      // Task orchestration switch
      switch (taskAnalysis.action) {
        case 'continue':
          if (sessionInfo.currentSession) {
            activeSessionId = sessionInfo.currentSession.session_id;
            activeSession = sessionInfo.currentSession;

            if (taskAnalysis.current_goal &&
                taskAnalysis.current_goal !== activeSession.original_goal &&
                latestUserMessage.length > 30) {
              updateSessionState(activeSessionId, {
                original_goal: taskAnalysis.current_goal,
              });
              activeSession.original_goal = taskAnalysis.current_goal;
            }

            taskLog('ORCHESTRATION_CONTINUE', {
              sessionId: activeSessionId,
              source: 'current_session',
              goal: activeSession.original_goal,
              goalUpdated: taskAnalysis.current_goal !== activeSession.original_goal,
            });
          } else if (sessionInfo.completedSession) {
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

            taskLog('ORCHESTRATION_CONTINUE', {
              sessionId: activeSessionId,
              source: 'reactivated_completed',
              goal: activeSession.original_goal,
            });
          }
          break;

        case 'new_task': {
          if (sessionInfo.completedSession) {
            deleteStepsForSession(sessionInfo.completedSession.session_id);
            deleteSessionState(sessionInfo.completedSession.session_id);
          }

          const newSessionId = randomUUID();
          activeSession = createSessionState({
            session_id: newSessionId,
            project_path: sessionInfo.projectPath,
            original_goal: taskAnalysis.current_goal,
            raw_user_prompt: rawUserPrompt,
            constraints: taskAnalysis.constraints || [],
            task_type: 'main',
          });
          activeSessionId = newSessionId;
          activeSessions.set(newSessionId, {
            sessionId: newSessionId,
            promptCount: 1,
            projectPath: sessionInfo.projectPath,
          });

          logger.info({ msg: 'Created new task session', sessionId: newSessionId.substring(0, 8) });
          taskLog('ORCHESTRATION_NEW_TASK', {
            sessionId: newSessionId,
            goal: taskAnalysis.current_goal,
            constraintsCount: (taskAnalysis.constraints || []).length,
          });

          // Q&A auto-save
          if (taskAnalysis.task_type === 'information' && textContent.length > 100 && actions.length === 0) {
            logger.info({ msg: 'Q&A detected (pure text) - saving immediately', sessionId: newSessionId.substring(0, 8) });
            taskLog('QA_AUTO_SAVE', {
              sessionId: newSessionId,
              goal: taskAnalysis.current_goal,
              responseLength: textContent.length,
              toolCalls: 0,
            });

            updateSessionState(newSessionId, {
              final_response: textContent.substring(0, 10000),
            });

            await saveToTeamMemory(newSessionId, 'complete', taskAnalysis.task_type, requestHeaders);
            markSessionCompleted(newSessionId);
          } else if (taskAnalysis.task_type === 'information' && actions.length > 0) {
            logger.info({ msg: 'Q&A with tool calls - waiting for completion', sessionId: newSessionId.substring(0, 8), toolCalls: actions.length });
            taskLog('QA_DEFERRED', {
              sessionId: newSessionId,
              goal: taskAnalysis.current_goal,
              toolCalls: actions.length,
            });
          }
          break;
        }

        case 'subtask': {
          const parentId = sessionInfo.currentSession?.session_id || taskAnalysis.parent_task_id;
          const subtaskId = randomUUID();
          activeSession = createSessionState({
            session_id: subtaskId,
            project_path: sessionInfo.projectPath,
            original_goal: taskAnalysis.current_goal,
            raw_user_prompt: rawUserPrompt,
            constraints: taskAnalysis.constraints || [],
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
          taskLog('ORCHESTRATION_SUBTASK', {
            sessionId: subtaskId,
            parentId: parentId || 'none',
            goal: taskAnalysis.current_goal,
          });
          break;
        }

        case 'parallel_task': {
          const parentId = sessionInfo.currentSession?.session_id || taskAnalysis.parent_task_id;
          const parallelId = randomUUID();
          activeSession = createSessionState({
            session_id: parallelId,
            project_path: sessionInfo.projectPath,
            original_goal: taskAnalysis.current_goal,
            raw_user_prompt: rawUserPrompt,
            constraints: taskAnalysis.constraints || [],
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
          taskLog('ORCHESTRATION_PARALLEL', {
            sessionId: parallelId,
            parentId: parentId || 'none',
            goal: taskAnalysis.current_goal,
          });
          break;
        }

        case 'task_complete': {
          if (sessionInfo.currentSession) {
            try {
              if (taskAnalysis.current_goal && !sessionInfo.currentSession.original_goal) {
                updateSessionState(sessionInfo.currentSession.session_id, {
                  original_goal: taskAnalysis.current_goal,
                });
                sessionInfo.currentSession.original_goal = taskAnalysis.current_goal;
              }

              updateSessionState(sessionInfo.currentSession.session_id, {
                final_response: textContent.substring(0, 10000),
              });

              await saveToTeamMemory(sessionInfo.currentSession.session_id, 'complete', taskAnalysis.task_type, requestHeaders);
              markSessionCompleted(sessionInfo.currentSession.session_id);
              activeSessions.delete(sessionInfo.currentSession.session_id);
              lastDriftResults.delete(sessionInfo.currentSession.session_id);

              taskLog('ORCHESTRATION_TASK_COMPLETE', {
                sessionId: sessionInfo.currentSession.session_id,
                goal: sessionInfo.currentSession.original_goal,
              });

              if (taskAnalysis.task_type === 'planning') {
                try {
                  const allSteps = getValidatedSteps(sessionInfo.currentSession.session_id);
                  const planSummary = await generateSessionSummary(sessionInfo.currentSession, allSteps, 2000, requestHeaders);

                  setPendingPlanClear({
                    projectPath: sessionInfo.projectPath,
                    summary: planSummary,
                  });

                  logger.info({
                    msg: 'PLANNING_CLEAR triggered',
                    sessionId: sessionInfo.currentSession.session_id.substring(0, 8),
                    summaryLen: planSummary.length,
                  });
                } catch {
                  // Silent fail - planning CLEAR is optional
                }
              }

              logger.info({ msg: 'Task complete - saved to team memory, marked completed' });
            } catch (err) {
              logger.info({ msg: 'Failed to save completed task', error: String(err) });
            }
          } else if (textContent.length > 100) {
            // Instant complete
            try {
              const newSessionId = randomUUID();
              const instantSession = createSessionState({
                session_id: newSessionId,
                project_path: sessionInfo.projectPath,
                original_goal: taskAnalysis.current_goal || '',
                raw_user_prompt: rawUserPrompt,
                task_type: 'main',
              });

              updateSessionState(newSessionId, {
                final_response: textContent.substring(0, 10000),
              });

              await saveToTeamMemory(newSessionId, 'complete', taskAnalysis.task_type, requestHeaders);
              markSessionCompleted(newSessionId);

              logger.info({ msg: 'Instant complete - new task saved immediately', sessionId: newSessionId.substring(0, 8) });
              taskLog('ORCHESTRATION_TASK_COMPLETE', {
                sessionId: newSessionId,
                goal: taskAnalysis.current_goal || '',
                source: 'instant_complete',
              });
            } catch (err) {
              logger.info({ msg: 'Failed to save instant complete task', error: String(err) });
            }
          }
          return;
        }

        case 'subtask_complete': {
          if (sessionInfo.currentSession) {
            const parentId = sessionInfo.currentSession.parent_session_id;
            try {
              await saveToTeamMemory(sessionInfo.currentSession.session_id, 'complete', taskAnalysis.task_type, requestHeaders);
              markSessionCompleted(sessionInfo.currentSession.session_id);
              activeSessions.delete(sessionInfo.currentSession.session_id);
              lastDriftResults.delete(sessionInfo.currentSession.session_id);

              if (parentId) {
                const parentSession = getSessionState(parentId);
                if (parentSession) {
                  activeSessionId = parentId;
                  activeSession = parentSession;
                  logger.info({ msg: 'Subtask complete - returning to parent', parent: parentId.substring(0, 8) });

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
      logger.info({ msg: 'Task analysis failed, creating fallback session', error: String(error) });

      if (!sessionInfo.currentSession) {
        const newSessionId = randomUUID();
        activeSession = createSessionState({
          session_id: newSessionId,
          project_path: sessionInfo.projectPath,
          original_goal: latestUserMessage.substring(0, 200),
          raw_user_prompt: rawUserPrompt,
          constraints: [],
          task_type: 'main',
        });
        activeSessionId = newSessionId;

        taskLog('FALLBACK_SESSION_CREATED', {
          sessionId: newSessionId,
          reason: 'task_analysis_failed',
          goal: latestUserMessage.substring(0, 80),
        });
      }
    }
  }

  // Token usage and CLEAR mode
  const usage = adapter.extractUsage(response);
  const actualContextSize = usage.cacheCreation + usage.cacheRead;

  if (activeSession) {
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

  // CLEAR mode pre-compute
  const preComputeThreshold = Math.floor(config.TOKEN_CLEAR_THRESHOLD * 0.85);

  if (activeSession &&
      actualContextSize > preComputeThreshold &&
      !activeSession.pending_clear_summary) {

    const allSteps = getValidatedSteps(activeSessionId);

    generateSessionSummary(activeSession, allSteps, 15000, requestHeaders).then(summary => {
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

  // Capture final_response
  if (isEndTurn && textContent.length > 100 && activeSessionId) {
    updateSessionState(activeSessionId, {
      final_response: textContent.substring(0, 10000),
    });
  }

  if (actions.length === 0) {
    return;
  }

  const toolNames = actions.map(a => a.toolName);
  logger.info({
    msg: 'Actions parsed',
    count: actions.length,
    tools: toolNames,
  });

  // Recovery alignment check
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

  // Drift check
  let driftScore: number | undefined;
  let skipSteps = false;
  const memSessionInfo = activeSessions.get(activeSessionId);
  const promptCount = memSessionInfo?.promptCount || sessionInfo.promptCount;

  const recentStepsForCheck = activeSessionId ? getRecentSteps(activeSessionId, 10) : [];
  const hasFileModifications = recentStepsForCheck.some(s =>
    s.action_type === 'edit' || s.action_type === 'write'
  );

  const hasValidGoal = activeSession?.original_goal &&
    activeSession.original_goal.length > 10 &&
    !activeSession.original_goal.includes('the original task');

  if (hasValidGoal && hasFileModifications && promptCount % config.DRIFT_CHECK_INTERVAL === 0) {
    if (activeSession) {
      const driftResult = await checkDrift({ sessionState: activeSession, recentSteps: recentStepsForCheck, latestUserMessage }, requestHeaders);

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
      const maxCorrectionAttempts = 2;
      const shouldCorrect = correctionLevel && currentEscalation < maxCorrectionAttempts;

      if (shouldCorrect && (correctionLevel === 'intervene' || correctionLevel === 'halt')) {
        updateSessionMode(activeSessionId, 'drifted');
        markWaitingForRecovery(activeSessionId, true);
        incrementEscalation(activeSessionId);

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
        updateSessionMode(activeSessionId, 'normal');
        markWaitingForRecovery(activeSessionId, false);
        lastDriftResults.delete(activeSessionId);
        updateSessionState(activeSessionId, {
          pending_correction: undefined,
          escalation_count: 0,
        });
      }

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

  // Save steps
  let previousReasoning: string | null = null;

  for (const action of actions) {
    const currentReasoning = textContent.substring(0, 1000);
    const isDuplicate = currentReasoning === previousReasoning;
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

// Helper functions

function getMessages(body: unknown): unknown[] {
  const b = body as Record<string, unknown>;
  if (Array.isArray(b.messages)) return b.messages;
  if (Array.isArray(b.input)) return b.input;
  return [];
}

function getMessageCount(body: unknown): number {
  return getMessages(body).length;
}

function getAssistantContent(response: unknown, adapter: AgentAdapter): unknown {
  const blocks = adapter.getToolUseBlocks(response);
  if (blocks.length > 0) {
    // Return the content array for Claude, or serialized for Codex
    const r = response as Record<string, unknown>;
    if (r.content) return r.content;
    if (r.output) return r.output;
  }
  return [];
}

function detectKeyDecision(
  action: { actionType: string; files: string[]; command?: string },
  reasoning: string
): boolean {
  if (action.actionType === 'edit' || action.actionType === 'write') {
    return true;
  }

  const decisionKeywords = [
    'decision', 'decided', 'chose', 'chosen', 'selected', 'picked',
    'approach', 'strategy', 'solution', 'implementation',
    'because', 'reason', 'rationale', 'trade-off', 'tradeoff',
    'instead of', 'rather than', 'prefer', 'opted',
    'conclusion', 'determined', 'resolved'
  ];

  const reasoningLower = reasoning.toLowerCase();
  const hasDecisionKeyword = decisionKeywords.some(kw => reasoningLower.includes(kw));

  if (hasDecisionKeyword && reasoning.length > 200) {
    return true;
  }

  return false;
}

// Export for server.ts startup/cleanup
export { activeSessions, lastDriftResults, lastMessageCount };
