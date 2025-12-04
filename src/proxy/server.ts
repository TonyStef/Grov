// Grov Proxy Server - Fastify + undici
// Intercepts Claude Code <-> Anthropic API traffic for drift detection and context injection

import { createHash } from 'crypto';
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
  getKeyDecisions,
  getEditedFiles,
  type SessionState,
  type TaskType,
} from '../lib/store.js';
import { smartTruncate } from '../lib/utils.js';
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
import * as fs from 'fs';
import * as path from 'path';

// Store last drift result for recovery alignment check
const lastDriftResults = new Map<string, DriftCheckResult>();

// Track last messageCount per session to detect retries vs new turns
const lastMessageCount = new Map<string, number>();

// Cache injection content per session (MUST be identical across requests for cache preservation)
// Stored in memory because session DB state doesn't exist on first request
const cachedInjections = new Map<string, string>();

// ============================================
// DELTA TRACKING - Avoid duplicate injections
// ============================================
// Track what has already been injected per session to only inject NEW content

interface SessionInjectionTracking {
  files: Set<string>;        // Files already mentioned in user message injection
  decisionIds: Set<string>;  // Step IDs of key decisions already injected
  reasonings: Set<string>;   // Reasoning content hashes already injected
}

const sessionInjectionTracking = new Map<string, SessionInjectionTracking>();

function getOrCreateTracking(sessionId: string): SessionInjectionTracking {
  if (!sessionInjectionTracking.has(sessionId)) {
    sessionInjectionTracking.set(sessionId, {
      files: new Set(),
      decisionIds: new Set(),
      reasonings: new Set(),
    });
  }
  return sessionInjectionTracking.get(sessionId)!;
}

/**
 * Build dynamic injection content for user message (DELTA only)
 * Includes: edited files, key decisions, drift correction, forced recovery
 * Only injects NEW content that hasn't been injected before
 */
function buildDynamicInjection(
  sessionId: string,
  sessionState: SessionState | null,
  logger?: { info: (data: Record<string, unknown>) => void }
): string | null {
  const tracking = getOrCreateTracking(sessionId);
  const parts: string[] = [];
  const debugInfo: Record<string, unknown> = {};

  // 1. Get edited files (delta - not already injected)
  const allEditedFiles = getEditedFiles(sessionId);
  const newFiles = allEditedFiles.filter(f => !tracking.files.has(f));
  debugInfo.totalEditedFiles = allEditedFiles.length;
  debugInfo.newEditedFiles = newFiles.length;
  debugInfo.alreadyTrackedFiles = tracking.files.size;

  if (newFiles.length > 0) {
    // Track and add to injection
    newFiles.forEach(f => tracking.files.add(f));
    const fileNames = newFiles.slice(0, 5).map(f => f.split('/').pop());
    parts.push(`[EDITED: ${fileNames.join(', ')}]`);
    debugInfo.editedFilesInjected = fileNames;
  }

  // 2. Get key decisions with reasoning (delta - not already injected)
  const keyDecisions = getKeyDecisions(sessionId, 5);
  debugInfo.totalKeyDecisions = keyDecisions.length;
  debugInfo.alreadyTrackedDecisions = tracking.decisionIds.size;

  const newDecisions = keyDecisions.filter(d =>
    !tracking.decisionIds.has(d.id) &&
    d.reasoning &&
    !tracking.reasonings.has(d.reasoning)
  );
  debugInfo.newKeyDecisions = newDecisions.length;

  for (const decision of newDecisions.slice(0, 3)) {
    tracking.decisionIds.add(decision.id);
    tracking.reasonings.add(decision.reasoning!);
    const truncated = smartTruncate(decision.reasoning!, 120);
    parts.push(`[DECISION: ${truncated}]`);

    // Log the original and truncated reasoning for debugging
    if (logger) {
      logger.info({
        msg: 'Key decision reasoning extracted',
        originalLength: decision.reasoning!.length,
        truncatedLength: truncated.length,
        original: decision.reasoning!.substring(0, 200) + (decision.reasoning!.length > 200 ? '...' : ''),
        truncated,
      });
    }
  }
  debugInfo.decisionsInjected = newDecisions.slice(0, 3).length;

  // 3. Add drift correction if pending
  if (sessionState?.pending_correction) {
    parts.push(`[DRIFT: ${sessionState.pending_correction}]`);
    debugInfo.hasDriftCorrection = true;
    debugInfo.driftCorrectionLength = sessionState.pending_correction.length;
  }

  // 4. Add forced recovery if pending
  if (sessionState?.pending_forced_recovery) {
    parts.push(`[RECOVERY: ${sessionState.pending_forced_recovery}]`);
    debugInfo.hasForcedRecovery = true;
    debugInfo.forcedRecoveryLength = sessionState.pending_forced_recovery.length;
  }

  // Log debug info
  if (logger) {
    logger.info({
      msg: 'Dynamic injection build details',
      ...debugInfo,
      partsCount: parts.length,
    });
  }

  if (parts.length === 0) {
    return null;
  }

  const injection = '---\n[GROV CONTEXT]\n' + parts.join('\n');

  // Log final injection content
  if (logger) {
    logger.info({
      msg: 'Dynamic injection content',
      size: injection.length,
      content: injection,
    });
  }

  return injection;
}

/**
 * Append dynamic injection to the last user message in raw body string
 * This preserves cache for system + previous messages, only the last user msg changes
 */
function appendToLastUserMessage(rawBody: string, injection: string): string {
  // Find the last occurrence of "role":"user" followed by content
  // We need to find the content field of the last user message and append to it

  // Strategy: Find all user messages, get the last one, append to its content
  // This is tricky because content can be string or array

  // Simpler approach: Find the last user message's closing content
  // Look for pattern: "role":"user","content":"..." or "role":"user","content":[...]

  // Find last "role":"user"
  const userRolePattern = /"role"\s*:\s*"user"/g;
  let lastUserMatch: RegExpExecArray | null = null;
  let match;

  while ((match = userRolePattern.exec(rawBody)) !== null) {
    lastUserMatch = match;
  }

  if (!lastUserMatch) {
    // No user message found, can't inject
    return rawBody;
  }

  // From lastUserMatch position, find the content field
  const afterRole = rawBody.slice(lastUserMatch.index);

  // Find "content" field after role
  const contentMatch = afterRole.match(/"content"\s*:\s*/);
  if (!contentMatch || contentMatch.index === undefined) {
    return rawBody;
  }

  const contentStartGlobal = lastUserMatch.index + contentMatch.index + contentMatch[0].length;
  const afterContent = rawBody.slice(contentStartGlobal);

  // Determine if content is string or array
  if (afterContent.startsWith('"')) {
    // String content - find closing quote (handling escapes)
    let i = 1; // Skip opening quote
    while (i < afterContent.length) {
      if (afterContent[i] === '\\') {
        i += 2; // Skip escaped char
      } else if (afterContent[i] === '"') {
        // Found closing quote
        const insertPos = contentStartGlobal + i;
        // Insert before closing quote, escape the injection for JSON
        const escapedInjection = injection
          .replace(/\\/g, '\\\\')
          .replace(/"/g, '\\"')
          .replace(/\n/g, '\\n');
        return rawBody.slice(0, insertPos) + '\\n\\n' + escapedInjection + rawBody.slice(insertPos);
      } else {
        i++;
      }
    }
  } else if (afterContent.startsWith('[')) {
    // Array content - find last text block and append, or add new text block
    // Find the closing ] of the content array
    let depth = 1;
    let i = 1;

    while (i < afterContent.length && depth > 0) {
      const char = afterContent[i];
      if (char === '[') depth++;
      else if (char === ']') depth--;
      else if (char === '"') {
        // Skip string
        i++;
        while (i < afterContent.length && afterContent[i] !== '"') {
          if (afterContent[i] === '\\') i++;
          i++;
        }
      }
      i++;
    }

    if (depth === 0) {
      // Found closing bracket at position i-1
      const insertPos = contentStartGlobal + i - 1;
      // Add new text block before closing bracket
      const escapedInjection = injection
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n');
      const newBlock = `,{"type":"text","text":"\\n\\n${escapedInjection}"}`;
      return rawBody.slice(0, insertPos) + newBlock + rawBody.slice(insertPos);
    }
  }

  // Fallback: couldn't parse, return unchanged
  return rawBody;
}

// ============================================
// DEBUG MODE - Controlled via --debug flag
// ============================================

let debugMode = false;

export function setDebugMode(enabled: boolean): void {
  debugMode = enabled;
}

// ============================================
// FILE LOGGER - Request/Response tracking (debug only)
// ============================================

const PROXY_LOG_PATH = path.join(process.cwd(), 'grov-proxy.log');
let requestCounter = 0;

interface ProxyLogEntry {
  timestamp: string;
  requestId: number;
  type: 'REQUEST' | 'RESPONSE' | 'INJECTION';
  sessionId?: string;
  data: Record<string, unknown>;
}

function proxyLog(entry: Omit<ProxyLogEntry, 'timestamp'>): void {
  if (!debugMode) return;  // Skip file logging unless --debug flag

  const logEntry: ProxyLogEntry = {
    timestamp: new Date().toISOString(),
    ...entry,
  };

  const line = JSON.stringify(logEntry) + '\n';
  fs.appendFileSync(PROXY_LOG_PATH, line);
}

/**
 * Log token usage to console (always shown, compact format)
 */
function logTokenUsage(
  requestId: number,
  usage: { cacheCreation: number; cacheRead: number; inputTokens: number; outputTokens: number },
  latencyMs: number
): void {
  const total = usage.cacheCreation + usage.cacheRead;
  const hitRatio = total > 0 ? ((usage.cacheRead / total) * 100).toFixed(0) : '0';
  console.log(
    `[${requestId}] ${hitRatio}% cache | in:${usage.inputTokens} out:${usage.outputTokens} | create:${usage.cacheCreation} read:${usage.cacheRead} | ${latencyMs}ms`
  );
}

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
    // Append as new text block WITHOUT cache_control
    // Anthropic allows max 4 cache blocks - Claude Code already uses 2+
    // Grov's injections are small (~2KB) so uncached is fine
    (body.system as Array<Record<string, unknown>>).push({
      type: 'text',
      text: textToAppend,
    });
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

/**
 * Inject text into raw body string WITHOUT re-serializing
 * This preserves the original formatting/whitespace for cache compatibility
 *
 * Adds a new text block to the end of the system array
 */
function injectIntoRawBody(rawBody: string, injectionText: string): { modified: string; success: boolean } {
  // Find the system array in the raw JSON
  // Pattern: "system": [....]
  const systemMatch = rawBody.match(/"system"\s*:\s*\[/);
  if (!systemMatch || systemMatch.index === undefined) {
    return { modified: rawBody, success: false };
  }

  // Find the matching closing bracket for the system array
  const startIndex = systemMatch.index + systemMatch[0].length;
  let bracketCount = 1;
  let endIndex = startIndex;

  for (let i = startIndex; i < rawBody.length && bracketCount > 0; i++) {
    const char = rawBody[i];
    if (char === '[') bracketCount++;
    else if (char === ']') bracketCount--;
    if (bracketCount === 0) {
      endIndex = i;
      break;
    }
  }

  if (bracketCount !== 0) {
    return { modified: rawBody, success: false };
  }

  // Escape the injection text for JSON
  const escapedText = JSON.stringify(injectionText).slice(1, -1); // Remove outer quotes

  // Create the new block (without cache_control - will be cache_creation)
  const newBlock = `,{"type":"text","text":"${escapedText}"}`;

  // Insert before the closing bracket
  const modified = rawBody.slice(0, endIndex) + newBlock + rawBody.slice(endIndex);

  return { modified, success: true };
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

  const currentRequestId = ++requestCounter;

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
  const processedBody = await preProcessRequest(request.body, sessionInfo, logger);
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
      postProcessResponse(result.body, sessionInfo, request.body, logger)
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
  sessionId: string
): 'first' | 'continuation' | 'retry' {
  const currentCount = messages?.length || 0;
  const lastCount = lastMessageCount.get(sessionId);
  lastMessageCount.set(sessionId, currentCount);

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
 * Pre-process request before forwarding
 * - Context injection (first request only)
 * - CLEAR operation (first request only)
 * - Drift correction (first request only)
 *
 * SKIP all injections on: retry, continuation
 */
async function preProcessRequest(
  body: MessagesRequestBody,
  sessionInfo: { sessionId: string; promptCount: number; projectPath: string },
  logger: { info: (data: Record<string, unknown>) => void }
): Promise<MessagesRequestBody> {
  const modified = { ...body };

  // Detect request type: first, continuation, or retry
  const requestType = detectRequestType(modified.messages || [], sessionInfo.sessionId);

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

      // 4. Clear pending summary and invalidate team memory cache (new baseline)
      updateSessionState(sessionInfo.sessionId, { pending_clear_summary: undefined });
      cachedInjections.delete(sessionInfo.sessionId);

      // 5. Clear tracking (fresh start after CLEAR)
      sessionInjectionTracking.delete(sessionInfo.sessionId);

      logger.info({ msg: 'CLEAR complete - conversation reset with summary' });

      return modified;  // Skip other injections - this is a complete reset
    }
  }

  // === STATIC INJECTION: Team memory (PAST sessions only) ===
  // Cached per session - identical across all requests for cache preservation

  const cachedTeamMemory = cachedInjections.get(sessionInfo.sessionId);

  if (cachedTeamMemory) {
    // Reuse cached team memory (constant for this session)
    (modified as Record<string, unknown>).__grovInjection = cachedTeamMemory;
    (modified as Record<string, unknown>).__grovInjectionCached = true;
    logger.info({ msg: 'Using cached team memory', size: cachedTeamMemory.length });
  } else {
    // First request: compute team memory from PAST sessions only
    const mentionedFiles = extractFilesFromMessages(modified.messages || []);
    // Pass currentSessionId to exclude current session data
    const teamContext = buildTeamMemoryContext(
      sessionInfo.projectPath,
      mentionedFiles,
      sessionInfo.sessionId  // Exclude current session
    );

    if (teamContext) {
      (modified as Record<string, unknown>).__grovInjection = teamContext;
      (modified as Record<string, unknown>).__grovInjectionCached = false;
      // Cache for future requests (stays constant)
      cachedInjections.set(sessionInfo.sessionId, teamContext);
      logger.info({ msg: 'Computed and cached team memory', size: teamContext.length });
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
  // Pre-compute summary before hitting 100% threshold to avoid blocking Haiku call
  const preComputeThreshold = Math.floor(config.TOKEN_CLEAR_THRESHOLD * 0.85);

  // Use actualContextSize (cacheCreation + cacheRead) as the real context size
  if (activeSession &&
      actualContextSize > preComputeThreshold &&
      !activeSession.pending_clear_summary &&
      isSummaryAvailable()) {

    // Get all validated steps for comprehensive summary
    const allSteps = getValidatedSteps(activeSessionId);

    // Generate summary asynchronously (fire-and-forget)
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

        // Pre-compute correction for next request (fire-and-forget pattern)
        // This avoids blocking Haiku calls in preProcessRequest
        const correction = buildCorrection(driftResult, activeSession, correctionLevel);
        const correctionText = formatCorrectionForInjection(correction);
        updateSessionState(activeSessionId, { pending_correction: correctionText });

        logger.info({
          msg: 'Pre-computed correction saved',
          level: correctionLevel,
          correctionLength: correctionText.length,
        });
      } else if (correctionLevel) {
        // Nudge or correct level - still save correction but don't change mode
        const correction = buildCorrection(driftResult, activeSession, correctionLevel);
        const correctionText = formatCorrectionForInjection(correction);
        updateSessionState(activeSessionId, { pending_correction: correctionText });

        logger.info({
          msg: 'Pre-computed mild correction saved',
          level: correctionLevel,
        });
      } else if (driftScore >= 8) {
        updateSessionMode(activeSessionId, 'normal');
        markWaitingForRecovery(activeSessionId, false);
        lastDriftResults.delete(activeSessionId);
        // Clear any pending correction since drift is resolved
        updateSessionState(activeSessionId, { pending_correction: undefined });
      }

      // FORCED MODE: escalation >= 3 triggers Haiku-generated recovery
      const currentEscalation = activeSession.escalation_count || 0;
      if (currentEscalation >= 3 && driftScore < 8) {
        updateSessionMode(activeSessionId, 'forced');

        // Generate forced recovery asynchronously (fire-and-forget within fire-and-forget)
        generateForcedRecovery(
          activeSession,
          recentSteps.map(s => ({ actionType: s.action_type, files: s.files })),
          driftResult
        ).then(forcedRecovery => {
          updateSessionState(activeSessionId, {
            pending_forced_recovery: forcedRecovery.injectionText,
          });
          logger.info({
            msg: 'Pre-computed forced recovery saved',
            escalation: currentEscalation,
            mandatoryAction: forcedRecovery.mandatoryAction?.substring(0, 50),
          });
        }).catch(err => {
          logger.info({ msg: 'Forced recovery generation failed', error: String(err) });
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

  // Save each action as a step (with reasoning from Claude's text)
  for (const action of actions) {
    // Detect key decisions based on action type and reasoning content
    const isKeyDecision = detectKeyDecision(action, textContent);

    createStep({
      session_id: activeSessionId,
      action_type: action.actionType,
      files: action.files,
      folders: action.folders,
      command: action.command,
      reasoning: textContent.substring(0, 1000),  // Claude's explanation (truncated)
      drift_score: driftScore,
      is_validated: !skipSteps,
      is_key_decision: isKeyDecision,
    });

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
 * Detect if an action represents a key decision worth injecting later
 * Key decisions are:
 * - Edit/write actions (code modifications)
 * - Actions with decision-related keywords in reasoning
 * - Actions with substantial reasoning content
 */
function detectKeyDecision(
  action: { actionType: string; files: string[]; command?: string },
  reasoning: string
): boolean {
  // Code modifications are always key decisions
  if (action.actionType === 'edit' || action.actionType === 'write') {
    return true;
  }

  // Check for decision-related keywords in reasoning
  const decisionKeywords = [
    'decision', 'decided', 'chose', 'chosen', 'selected', 'picked',
    'approach', 'strategy', 'solution', 'implementation',
    'because', 'reason', 'rationale', 'trade-off', 'tradeoff',
    'instead of', 'rather than', 'prefer', 'opted',
    'conclusion', 'determined', 'resolved'
  ];

  const reasoningLower = reasoning.toLowerCase();
  const hasDecisionKeyword = decisionKeywords.some(kw => reasoningLower.includes(kw));

  // Substantial reasoning (>200 chars) with decision keyword = key decision
  if (hasDecisionKeyword && reasoning.length > 200) {
    return true;
  }

  return false;
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
  // Set debug mode based on flag
  if (options.debug) {
    setDebugMode(true);
    console.log('[DEBUG] Logging to grov-proxy.log');
  }

  const server = createServer();

  // Cleanup old completed sessions (older than 24 hours)
  cleanupOldCompletedSessions();

  try {
    await server.listen({
      host: config.HOST,
      port: config.PORT,
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
