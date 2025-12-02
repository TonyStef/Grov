// Grov Proxy Server - Fastify + undici
// Intercepts Claude Code <-> Anthropic API traffic for drift detection and context injection

import Fastify, { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { config, maskSensitiveValue } from './config.js';
import { forwardToAnthropic, isForwardError } from './forwarder.js';
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
} from '../lib/llm-extractor.js';
import { buildTeamMemoryContext, extractFilesFromMessages } from './request-processor.js';
import { saveToTeamMemory, cleanupSession } from './response-processor.js';
import { randomUUID } from 'crypto';

// Store last drift result for recovery alignment check
const lastDriftResults = new Map<string, DriftCheckResult>();

// Request body type
interface MessagesRequestBody {
  model: string;
  messages: Array<{ role: string; content: unknown }>;
  system?: string | Array<{ type: string; text: string }>;
  max_tokens?: number;
  [key: string]: unknown;
}

/**
 * Helper to append text to system prompt (handles string or array format)
 */
function appendToSystemPrompt(
  body: MessagesRequestBody,
  textToAppend: string
): void {
  if (typeof body.system === 'string') {
    body.system = body.system + textToAppend;
  } else if (Array.isArray(body.system)) {
    // Append as new text block
    body.system.push({ type: 'text', text: textToAppend });
  } else {
    // No system prompt yet, create as string
    body.system = textToAppend;
  }
}

/**
 * Get system prompt as string (for reading)
 */
function getSystemPromptText(body: MessagesRequestBody): string {
  if (typeof body.system === 'string') {
    return body.system;
  } else if (Array.isArray(body.system)) {
    return body.system
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n');
  }
  return '';
}

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

  // Health check endpoint
  fastify.get('/health', async () => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });

  // Main messages endpoint
  fastify.post('/v1/messages', {
    config: {
      rawBody: true,
    },
  }, handleMessages);

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

  // Skip Haiku subagents - forward directly without any tracking
  // Haiku requests are Task tool spawns for exploration, they don't make decisions
  // All reasoning and decisions happen in the main model (Opus/Sonnet)
  if (model.includes('haiku')) {
    logger.info({ msg: 'Skipping Haiku subagent', model });

    try {
      const result = await forwardToAnthropic(
        request.body,
        request.headers as Record<string, string | string[] | undefined>,
        logger
      );

      const latency = Date.now() - startTime;

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

  logger.info({
    msg: 'Incoming request',
    sessionId: sessionInfo.sessionId.substring(0, 8),
    promptCount: sessionInfo.promptCount,
    model: request.body.model,
    messageCount: request.body.messages?.length || 0,
  });

  // === PRE-HANDLER: Modify request if needed ===
  const modifiedBody = await preProcessRequest(request.body, sessionInfo, logger);

  // === FORWARD TO ANTHROPIC ===
  try {
    const result = await forwardToAnthropic(
      modifiedBody,
      request.headers as Record<string, string | string[] | undefined>,
      logger
    );

    // === POST-HANDLER: Process response with task orchestration ===
    if (result.statusCode === 200 && isAnthropicResponse(result.body)) {
      await postProcessResponse(result.body, sessionInfo, request.body, logger);
    }

    // Return response to Claude Code (unmodified)
    const latency = Date.now() - startTime;
    logger.info({
      msg: 'Request complete',
      statusCode: result.statusCode,
      latencyMs: latency,
    });

    return reply
      .status(result.statusCode)
      .header('content-type', 'application/json')
      .headers(filterResponseHeaders(result.headers))
      .send(JSON.stringify(result.body));

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

  logger.info({ msg: 'No existing session, will create after task analysis' });

  return { ...sessionInfo, isNew: true, currentSession: null, completedSession };
}

/**
 * Pre-process request before forwarding
 * - Context injection
 * - CLEAR operation
 */
async function preProcessRequest(
  body: MessagesRequestBody,
  sessionInfo: { sessionId: string; promptCount: number; projectPath: string },
  logger: { info: (data: Record<string, unknown>) => void }
): Promise<MessagesRequestBody> {
  const modified = { ...body };
  const sessionState = getSessionState(sessionInfo.sessionId);

  if (!sessionState) {
    return modified;
  }

  // Extract latest user message for drift checking
  const latestUserMessage = extractGoalFromMessages(body.messages) || '';

  // CLEAR operation if token threshold exceeded
  if ((sessionState.token_count || 0) > config.TOKEN_CLEAR_THRESHOLD) {
    logger.info({
      msg: 'Token threshold exceeded, initiating CLEAR',
      tokenCount: sessionState.token_count,
      threshold: config.TOKEN_CLEAR_THRESHOLD,
    });

    // Generate summary from session state + steps
    let summary: string;
    if (isSummaryAvailable()) {
      const steps = getValidatedSteps(sessionInfo.sessionId);
      summary = await generateSessionSummary(sessionState, steps);
    } else {
      const files = getValidatedSteps(sessionInfo.sessionId).flatMap(s => s.files);
      summary = `PREVIOUS SESSION CONTEXT:
Goal: ${sessionState.original_goal || 'Not specified'}
Files worked on: ${[...new Set(files)].slice(0, 10).join(', ') || 'None'}
Please continue from where you left off.`;
    }

    // Clear messages and inject summary
    modified.messages = [];
    appendToSystemPrompt(modified, '\n\n' + summary);

    // Update session state
    markCleared(sessionInfo.sessionId);

    logger.info({
      msg: 'CLEAR completed',
      summaryLength: summary.length,
    });
  }

  // Check if session is in drifted or forced mode
  if (sessionState.session_mode === 'drifted' || sessionState.session_mode === 'forced') {
    const recentSteps = getRecentSteps(sessionInfo.sessionId, 5);

    // FORCED MODE: escalation >= 3 -> Haiku generates recovery prompt
    if (sessionState.escalation_count >= 3 || sessionState.session_mode === 'forced') {
      // Update mode to forced if not already
      if (sessionState.session_mode !== 'forced') {
        updateSessionMode(sessionInfo.sessionId, 'forced');
      }

      const lastDrift = lastDriftResults.get(sessionInfo.sessionId);
      const driftResult = lastDrift || await checkDrift({ sessionState, recentSteps, latestUserMessage });

      const forcedRecovery = await generateForcedRecovery(
        sessionState,
        recentSteps.map(s => ({ actionType: s.action_type, files: s.files })),
        driftResult
      );

      appendToSystemPrompt(modified, forcedRecovery.injectionText);

      logger.info({
        msg: 'FORCED MODE - Injected Haiku recovery prompt',
        escalation: sessionState.escalation_count,
        mandatoryAction: forcedRecovery.mandatoryAction.substring(0, 50),
      });
    } else {
      // DRIFTED MODE: normal correction injection
      const driftResult = await checkDrift({ sessionState, recentSteps, latestUserMessage });
      const correctionLevel = scoreToCorrectionLevel(driftResult.score);

      if (correctionLevel) {
        const correction = buildCorrection(driftResult, sessionState, correctionLevel);
        const correctionText = formatCorrectionForInjection(correction);

        appendToSystemPrompt(modified, correctionText);

        logger.info({
          msg: 'Injected correction',
          level: correctionLevel,
          score: driftResult.score,
        });
      }
    }
  }

  // Inject context from team memory
  const mentionedFiles = extractFilesFromMessages(modified.messages || []);
  const teamContext = buildTeamMemoryContext(sessionInfo.projectPath, mentionedFiles);

  if (teamContext) {
    appendToSystemPrompt(modified, '\n\n' + teamContext);
  }

  return modified;
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
  logger: { info: (data: Record<string, unknown>) => void }
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


  // If not end_turn (tool_use in progress), skip task orchestration but keep session
  if (!isEndTurn) {
    // Use existing session or create minimal one without LLM calls
    if (sessionInfo.currentSession) {
      activeSessionId = sessionInfo.currentSession.session_id;
      activeSession = sessionInfo.currentSession;
    } else if (!activeSession) {
      // First request, create session without task analysis
      const newSessionId = randomUUID();
      activeSession = createSessionState({
        session_id: newSessionId,
        project_path: sessionInfo.projectPath,
        original_goal: latestUserMessage.substring(0, 500) || 'Task in progress',
        task_type: 'main',
      });
      activeSessionId = newSessionId;
      activeSessions.set(newSessionId, {
        sessionId: newSessionId,
        promptCount: 1,
        projectPath: sessionInfo.projectPath,
      });
    }
  } else if (isTaskAnalysisAvailable()) {
    // Use completed session for comparison if no active session
    const sessionForComparison = sessionInfo.currentSession || sessionInfo.completedSession;
    try {
      const taskAnalysis = await analyzeTaskContext(
        sessionForComparison,
        latestUserMessage,
        recentSteps,
        textContent
      );

      logger.info({
        msg: 'Task analysis',
        action: taskAnalysis.action,
        topic_match: taskAnalysis.topic_match,
        goal: taskAnalysis.current_goal?.substring(0, 50),
        reasoning: taskAnalysis.reasoning,
      });

      // Update recent steps with reasoning (backfill from end_turn response)
      if (taskAnalysis.step_reasoning && activeSessionId) {
        const updatedCount = updateRecentStepsReasoning(activeSessionId, taskAnalysis.step_reasoning);
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
            } catch (err) {
              logger.info({ msg: 'Intent extraction failed, using basic goal', error: String(err) });
            }
          }

          const newSessionId = randomUUID();
          activeSession = createSessionState({
            session_id: newSessionId,
            project_path: sessionInfo.projectPath,
            original_goal: intentData.goal,
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
            } catch { /* use fallback */ }
          }

          const parentId = sessionInfo.currentSession?.session_id || taskAnalysis.parent_task_id;
          const subtaskId = randomUUID();
          activeSession = createSessionState({
            session_id: subtaskId,
            project_path: sessionInfo.projectPath,
            original_goal: intentData.goal,
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
            } catch { /* use fallback */ }
          }

          const parentId = sessionInfo.currentSession?.session_id || taskAnalysis.parent_task_id;
          const parallelId = randomUUID();
          activeSession = createSessionState({
            session_id: parallelId,
            project_path: sessionInfo.projectPath,
            original_goal: intentData.goal,
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
          break;
        }

        case 'task_complete': {
          // Save to team memory and mark as completed (don't delete yet - keep for new_task detection)
          if (sessionInfo.currentSession) {
            try {
              await saveToTeamMemory(sessionInfo.currentSession.session_id, 'complete');
              markSessionCompleted(sessionInfo.currentSession.session_id);
              activeSessions.delete(sessionInfo.currentSession.session_id);
              lastDriftResults.delete(sessionInfo.currentSession.session_id);
              logger.info({ msg: 'Task complete - saved to team memory, marked completed' });
            } catch (err) {
              logger.info({ msg: 'Failed to save completed task', error: String(err) });
            }
          }
          return; // Done, no more processing needed
        }

        case 'subtask_complete': {
          // Save subtask and mark completed, return to parent
          if (sessionInfo.currentSession) {
            const parentId = sessionInfo.currentSession.parent_session_id;
            try {
              await saveToTeamMemory(sessionInfo.currentSession.session_id, 'complete');
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
          goal: latestUserMessage.substring(0, 500),
          expected_scope: [] as string[],
          constraints: [] as string[],
          keywords: [] as string[],
        };
        if (isIntentExtractionAvailable() && latestUserMessage.length > 10) {
          try {
            intentData = await extractIntent(latestUserMessage);
          } catch { /* use fallback */ }
        }

        const newSessionId = randomUUID();
        activeSession = createSessionState({
          session_id: newSessionId,
          project_path: sessionInfo.projectPath,
          original_goal: intentData.goal,
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
    if (!sessionInfo.currentSession) {
      let intentData = {
        goal: latestUserMessage.substring(0, 500),
        expected_scope: [] as string[],
        constraints: [] as string[],
        keywords: [] as string[],
      };
      if (isIntentExtractionAvailable() && latestUserMessage.length > 10) {
        try {
          intentData = await extractIntent(latestUserMessage);
          logger.info({ msg: 'Intent extracted (fallback)', scopeCount: intentData.expected_scope.length });
        } catch { /* use fallback */ }
      }

      const newSessionId = randomUUID();
      activeSession = createSessionState({
        session_id: newSessionId,
        project_path: sessionInfo.projectPath,
        original_goal: intentData.goal,
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

  // Extract token usage
  const usage = extractTokenUsage(response);
  if (activeSession) {
    updateTokenCount(activeSessionId, usage.totalTokens);
  }

  logger.info({
    msg: 'Token usage',
    input: usage.inputTokens,
    output: usage.outputTokens,
    total: usage.totalTokens,
    activeSession: activeSessionId.substring(0, 8),
  });

  if (actions.length === 0) {
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

  // Run drift check every N prompts
  let driftScore: number | undefined;
  let skipSteps = false;
  const memSessionInfo = activeSessions.get(activeSessionId);
  const promptCount = memSessionInfo?.promptCount || sessionInfo.promptCount;

  if (promptCount % config.DRIFT_CHECK_INTERVAL === 0 && isDriftCheckAvailable()) {
    if (activeSession) {
      const stepsForDrift = getRecentSteps(activeSessionId, 10);
      const driftResult = await checkDrift({ sessionState: activeSession, recentSteps: stepsForDrift, latestUserMessage });

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
      if (correctionLevel === 'intervene' || correctionLevel === 'halt') {
        updateSessionMode(activeSessionId, 'drifted');
        markWaitingForRecovery(activeSessionId, true);
        incrementEscalation(activeSessionId);
      } else if (driftScore >= 8) {
        updateSessionMode(activeSessionId, 'normal');
        markWaitingForRecovery(activeSessionId, false);
        lastDriftResults.delete(activeSessionId);
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

  // Save each action as a step (with reasoning from Claude's text)
  for (const action of actions) {
    createStep({
      session_id: activeSessionId,
      action_type: action.actionType,
      files: action.files,
      folders: action.folders,
      command: action.command,
      reasoning: textContent.substring(0, 1000),  // Claude's explanation (truncated)
      drift_score: driftScore,
      is_validated: !skipSteps,
    });
  }
}

/**
 * Extract text content from response for analysis
 */
function extractTextContent(response: AnthropicResponse): string {
  return response.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map(block => block.text)
    .join('\n');
}

/**
 * Detect task completion from response text
 * Returns trigger type or null
 */
function detectTaskCompletion(text: string): 'complete' | 'subtask' | null {
  const lowerText = text.toLowerCase();

  // Strong completion indicators
  const completionPhrases = [
    'task is complete',
    'task complete',
    'implementation is complete',
    'implementation complete',
    'successfully implemented',
    'all changes have been made',
    'finished implementing',
    'completed the implementation',
    'done with the implementation',
    'completed all the',
    'all tests pass',
    'build succeeds',
  ];

  for (const phrase of completionPhrases) {
    if (lowerText.includes(phrase)) {
      return 'complete';
    }
  }

  // Subtask completion indicators
  const subtaskPhrases = [
    'step complete',
    'phase complete',
    'finished this step',
    'moving on to',
    'now let\'s',
    'next step',
  ];

  for (const phrase of subtaskPhrases) {
    if (lowerText.includes(phrase)) {
      return 'subtask';
    }
  }

  return null;
}

/**
 * Extract project path from request body
 */
function extractProjectPath(body: MessagesRequestBody): string | null {
  // Try to extract from system prompt or messages
  // Handle both string and array format for system prompt
  let systemPrompt = '';
  if (typeof body.system === 'string') {
    systemPrompt = body.system;
  } else if (Array.isArray(body.system)) {
    // New API format: system is array of {type: 'text', text: '...'}
    systemPrompt = body.system
      .filter((block): block is { type: string; text: string } =>
        block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
      .map(block => block.text)
      .join('\n');
  }
  const cwdMatch = systemPrompt.match(/Working directory:\s*([^\n]+)/);
  if (cwdMatch) {
    return cwdMatch[1].trim();
  }
  return null;
}

/**
 * Extract goal from FIRST user message with text content
 * Skips tool_result blocks, filters out system-reminder tags
 */
function extractGoalFromMessages(messages: Array<{ role: string; content: unknown }>): string | undefined {
  const userMessages = messages?.filter(m => m.role === 'user') || [];

  for (const userMsg of userMessages) {
    let rawContent = '';

    // Handle string content
    if (typeof userMsg.content === 'string') {
      rawContent = userMsg.content;
    }

    // Handle array content - look for text blocks (skip tool_result)
    if (Array.isArray(userMsg.content)) {
      const textBlocks = userMsg.content
        .filter((block): block is { type: string; text: string } =>
          block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
        .map(block => block.text);
      rawContent = textBlocks.join('\n');
    }

    // Remove <system-reminder>...</system-reminder> tags
    const cleanContent = rawContent
      .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
      .trim();

    // If we found valid text content, return it
    if (cleanContent && cleanContent.length >= 5) {
      return cleanContent.substring(0, 500);
    }
  }

  return undefined;
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
    'anthropic-ratelimit-requests-limit',
    'anthropic-ratelimit-requests-remaining',
    'anthropic-ratelimit-tokens-limit',
    'anthropic-ratelimit-tokens-remaining',
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
 */
export async function startServer(): Promise<FastifyInstance> {
  const server = createServer();

  // Cleanup old completed sessions (older than 24 hours)
  const cleanedUp = cleanupOldCompletedSessions();
  if (cleanedUp > 0) {
  }

  try {
    await server.listen({
      host: config.HOST,
      port: config.PORT,
    });

    console.log(`✓ Grov Proxy: http://${config.HOST}:${config.PORT} → ${config.ANTHROPIC_BASE_URL}`);

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
