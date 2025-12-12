// Grov Proxy Server - Fastify + undici
// Intercepts Claude Code <-> Anthropic API traffic for drift detection and context injection

import { createHash } from 'crypto';
import Fastify, { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { config, maskSensitiveValue, buildSafeHeaders } from './config.js';
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
  cleanupStaleActiveSessions,
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
  type ConversationMessage,
} from '../lib/llm-extractor.js';
import { extractFilesFromMessages, extractLastUserPrompt, buildTeamMemoryContextCloud } from './request-processor.js';
import { isSyncEnabled, getSyncTeamId } from '../lib/cloud-sync.js';
import {
  globalTeamMemoryCache,
  invalidateTeamMemoryCache,
  setTeamMemoryCache,
} from './cache.js';
import { saveToTeamMemory, cleanupSession } from './response-processor.js';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

// Store last drift result for recovery alignment check
const lastDriftResults = new Map<string, DriftCheckResult>();

// Server logger reference (set in startServer)
let serverLog: { info: (msg: string | object) => void } | null = null;

/** Log helper for extended cache - always uses console.log for visibility */
function log(msg: string): void {
  console.log(`[CACHE] ${msg}`);
}

// Track last messageCount per session to detect retries vs new turns
const lastMessageCount = new Map<string, number>();

// NOTE: globalTeamMemoryCache moved to cache.ts to avoid circular dependencies
// Import: globalTeamMemoryCache, invalidateTeamMemoryCache, setTeamMemoryCache from './cache.js'

// Pending plan summary - triggers CLEAR-like reset after planning task completes
// This ensures implementation phase starts fresh with planning context injected
let pendingPlanClear: { projectPath: string; summary: string } | null = null;

// ============================================
// EXTENDED CACHE - Keep Anthropic cache alive during idle
// ============================================

interface ExtendedCacheEntry {
  headers: Record<string, string>;  // Safe headers via buildSafeHeaders()
  rawBody: Buffer;                  // Exact request bytes for prefix matching
  timestamp: number;                // Last activity (for idle calculation)
  keepAliveCount: number;           // Track attempts (max 2)
}

const extendedCache = new Map<string, ExtendedCacheEntry>();

// Timing constants
const EXTENDED_CACHE_IDLE_THRESHOLD = 4 * 60 * 1000;  // 4 minutes (under 5-min TTL)
const EXTENDED_CACHE_MAX_IDLE = 10 * 60 * 1000;       // 10 minutes total
const EXTENDED_CACHE_MAX_KEEPALIVES = 2;
const EXTENDED_CACHE_MAX_ENTRIES = 100;               // Max concurrent sessions (memory cap)

/**
 * Evict oldest entry if cache is at capacity.
 * Uses LRU based on timestamp.
 */
function evictOldestCacheEntry(): void {
  if (extendedCache.size < EXTENDED_CACHE_MAX_ENTRIES) return;

  let oldestId: string | null = null;
  let oldestTime = Infinity;

  for (const [id, entry] of extendedCache) {
    if (entry.timestamp < oldestTime) {
      oldestTime = entry.timestamp;
      oldestId = id;
    }
  }

  if (oldestId) {
    extendedCache.delete(oldestId);
    log(`Extended cache: evicted ${oldestId.substring(0, 8)} (capacity limit)`);
  }
}

/**
 * Send keep-alive request to Anthropic to refresh cache TTL.
 * CRITICAL: Uses raw string manipulation to preserve cache prefix matching.
 */
async function sendExtendedCacheKeepAlive(projectPath: string, entry: ExtendedCacheEntry): Promise<void> {
  const projectName = projectPath.split('/').pop() || projectPath;
  let rawBodyStr = entry.rawBody.toString('utf-8');

  // 1. Find messages array and add "." message before closing bracket
  const messagesMatch = rawBodyStr.match(/"messages"\s*:\s*\[/);
  if (!messagesMatch || messagesMatch.index === undefined) {
    throw new Error('Cannot find messages array in rawBody');
  }

  // Find closing bracket of messages array (handling nested arrays/objects)
  const messagesStart = messagesMatch.index + messagesMatch[0].length;
  let bracketDepth = 1;  // We're inside the [ already
  let braceDepth = 0;    // Track {} for objects
  let inString = false;  // Track if we're inside a string
  let messagesEnd = messagesStart;

  for (let i = messagesStart; i < rawBodyStr.length && bracketDepth > 0; i++) {
    const char = rawBodyStr[i];
    const prevChar = i > 0 ? rawBodyStr[i - 1] : '';

    // Handle string boundaries (skip escaped quotes)
    if (char === '"' && prevChar !== '\\') {
      inString = !inString;
      continue;
    }

    // Skip everything inside strings
    if (inString) continue;

    // Track brackets and braces
    if (char === '[') bracketDepth++;
    else if (char === ']') bracketDepth--;
    else if (char === '{') braceDepth++;
    else if (char === '}') braceDepth--;

    // Found the closing bracket of messages array
    if (bracketDepth === 0) {
      messagesEnd = i;
      break;
    }
  }

  // Safety check: did we find the end?
  if (bracketDepth !== 0) {
    throw new Error(`Could not find closing bracket of messages array (depth=${bracketDepth})`);
  }

  // Check if array has content (anything between messagesStart and messagesEnd)
  const arrayContent = rawBodyStr.slice(messagesStart, messagesEnd).trim();
  const messagesIsEmpty = arrayContent.length === 0;

  // Insert minimal user message before closing bracket
  const keepAliveMsg = messagesIsEmpty
    ? '{"role":"user","content":"."}'
    : ',{"role":"user","content":"."}';

  log(`Extended cache: SEND keep-alive project=${projectName} msg_array_size=${messagesEnd - messagesStart}`);

  rawBodyStr = rawBodyStr.slice(0, messagesEnd) + keepAliveMsg + rawBodyStr.slice(messagesEnd);

  // NOTE: We do NOT modify max_tokens or stream!
  // Keeping them identical preserves the cache prefix for byte-exact matching.
  // Claude will respond briefly to "." anyway, and forwarder handles streaming.

  // 2. Validate JSON after manipulation
  try {
    JSON.parse(rawBodyStr);
  } catch (e) {
    throw new Error(`Invalid JSON after modifications: ${e instanceof Error ? e.message : 'unknown'}`);
  }

  // 5. Forward to Anthropic using same undici path as regular requests
  const result = await forwardToAnthropic(
    {},
    entry.headers as Record<string, string | string[] | undefined>,
    undefined,
    Buffer.from(rawBodyStr, 'utf-8')
  );

  if (result.statusCode !== 200) {
    throw new Error(`Keep-alive failed: ${result.statusCode}`);
  }

  // Log cache metrics
  const usage = (result.body as Record<string, unknown>).usage as Record<string, number> | undefined;
  const cacheRead = usage?.cache_read_input_tokens || 0;
  const cacheCreate = usage?.cache_creation_input_tokens || 0;
  const inputTokens = usage?.input_tokens || 0;
  log(`Extended cache: keep-alive for ${projectName} - cache_read=${cacheRead}, cache_create=${cacheCreate}, input=${inputTokens}`);
}

/**
 * Check all extended cache entries and send keep-alives for idle sessions.
 * Uses Promise.all for parallel execution.
 */
async function checkExtendedCache(): Promise<void> {
  const now = Date.now();
  const projectsToKeepAlive: Array<{ projectPath: string; entry: ExtendedCacheEntry }> = [];

  // First pass: cleanup stale/maxed entries, collect projects needing keep-alive
  for (const [projectPath, entry] of extendedCache) {
    const idleTime = now - entry.timestamp;
    const projectName = projectPath.split('/').pop() || projectPath;

    // Stale cleanup: user left after 10 minutes
    if (idleTime > EXTENDED_CACHE_MAX_IDLE) {
      extendedCache.delete(projectPath);
      log(`Extended cache: cleared ${projectName} (stale)`);
      continue;
    }

    // Skip if not idle enough yet
    if (idleTime < EXTENDED_CACHE_IDLE_THRESHOLD) {
      continue;
    }

    // Skip if already sent max keep-alives
    if (entry.keepAliveCount >= EXTENDED_CACHE_MAX_KEEPALIVES) {
      extendedCache.delete(projectPath);
      log(`Extended cache: cleared ${projectName} (max retries)`);
      continue;
    }

    projectsToKeepAlive.push({ projectPath, entry });
  }

  // Second pass: send all keep-alives in PARALLEL
  const keepAlivePromises: Promise<void>[] = [];

  for (const { projectPath, entry } of projectsToKeepAlive) {
    const projectName = projectPath.split('/').pop() || projectPath;
    const promise = sendExtendedCacheKeepAlive(projectPath, entry)
      .then(() => {
        entry.timestamp = Date.now();
        entry.keepAliveCount++;
      })
      .catch((err) => {
        extendedCache.delete(projectPath);
        // Handle both Error instances and ForwardError objects
        const errMsg = err instanceof Error
          ? err.message
          : (err && typeof err === 'object' && 'message' in err)
            ? String(err.message)
            : JSON.stringify(err);
        const errType = err && typeof err === 'object' && 'type' in err ? ` [${err.type}]` : '';
        log(`Extended cache: cleared ${projectName} (error${errType}: ${errMsg})`);
      });

    keepAlivePromises.push(promise);
  }

  // Wait for all keep-alives to complete
  if (keepAlivePromises.length > 0) {
    await Promise.all(keepAlivePromises);
  }
}

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
const TASK_LOG_PATH = path.join(process.cwd(), 'grov-task.log');

/**
 * Task orchestration logger - always active, writes to grov-task.log
 * Logs: task analysis, intent extraction, orchestration, reasoning
 */
function taskLog(event: string, data: Record<string, unknown>): void {
  const timestamp = new Date().toISOString();
  const sessionId = data.sessionId ? String(data.sessionId).substring(0, 8) : '-';

  // Format: [timestamp] [session] EVENT: key=value key=value
  const kvPairs = Object.entries(data)
    .filter(([k]) => k !== 'sessionId')
    .map(([k, v]) => {
      const val = typeof v === 'string' ? v.substring(0, 100) : JSON.stringify(v);
      return `${k}=${val}`;
    })
    .join(' | ');

  const line = `[${timestamp}] [${sessionId}] ${event}: ${kvPairs}\n`;
  fs.appendFileSync(TASK_LOG_PATH, line);
}
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

  // Skip warmup requests - Claude Code sends "Warmup" as health check
  // No need to do semantic search or cache operations for these
  const earlyUserPrompt = extractLastUserPrompt(modified.messages || []);
  if (earlyUserPrompt === 'Warmup') {
    console.log('[INJECT] Skipping warmup request (no search, no cache)');
    return modified;
  }

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
    sessionInjectionTracking.delete(sessionInfo.sessionId);

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
      sessionInjectionTracking.delete(sessionInfo.sessionId);

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
    log(`Extended cache: CAPTURE project=${cacheKey.split('/').pop()} size=${rawStr.length} sys=${hasSystem} tools=${hasTools} cache_ctrl=${hasCacheCtrl} msg_pos=${msgPos}`);
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
            await saveToTeamMemory(newSessionId, 'complete');
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
              // Set final_response BEFORE saving so reasoning extraction has the data
              updateSessionState(sessionInfo.currentSession.session_id, {
                final_response: textContent.substring(0, 10000),
              });

              await saveToTeamMemory(sessionInfo.currentSession.session_id, 'complete');
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
                  pendingPlanClear = {
                    projectPath: sessionInfo.projectPath,
                    summary: planSummary,
                  };

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
                original_goal: taskAnalysis.current_goal || latestUserMessage.substring(0, 500),
                task_type: 'main',
              });

              // Set final_response for reasoning extraction
              updateSessionState(newSessionId, {
                final_response: textContent.substring(0, 10000),
              });

              await saveToTeamMemory(newSessionId, 'complete');
              markSessionCompleted(newSessionId);
              logger.info({ msg: 'Instant complete - new task saved immediately', sessionId: newSessionId.substring(0, 8) });

              // TASK LOG: Instant complete (new task that finished in one turn)
              taskLog('ORCHESTRATION_TASK_COMPLETE', {
                sessionId: newSessionId,
                goal: taskAnalysis.current_goal || latestUserMessage.substring(0, 80),
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
          goal: latestUserMessage.substring(0, 500),
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
        goal: latestUserMessage.substring(0, 500),
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

  // Iterate in REVERSE to get the LAST (most recent) user message
  for (const userMsg of [...userMessages].reverse()) {
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

    // Remove <system-reminder>...</system-reminder> tags (including orphaned tags from split content blocks)
    const cleanContent = rawContent
      .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
      .replace(/<\/system-reminder>/g, '')
      .replace(/<system-reminder>[^<]*/g, '')
      .trim();

    // If we found valid text content, return it
    if (cleanContent && cleanContent.length >= 5) {
      return cleanContent.substring(0, 500);
    }
  }

  return undefined;
}

/**
 * Extract conversation history from messages for task analysis
 * Returns last 10 messages in ConversationMessage format
 */
function extractConversationHistory(
  messages: Array<{ role: string; content: unknown }>
): ConversationMessage[] {
  if (!messages || messages.length === 0) return [];

  const result: ConversationMessage[] = [];

  for (const msg of messages.slice(-10)) {
    if (msg.role !== 'user' && msg.role !== 'assistant') continue;

    let textContent = '';

    // Handle string content
    if (typeof msg.content === 'string') {
      textContent = msg.content;
    }

    // Handle array content - extract text blocks only
    if (Array.isArray(msg.content)) {
      const textBlocks = msg.content
        .filter((block): block is { type: string; text: string } =>
          block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
        .map(block => block.text);
      textContent = textBlocks.join('\n');
    }

    // Remove system-reminder tags
    const cleanContent = textContent
      .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
      .trim();

    if (cleanContent && cleanContent.length > 0) {
      result.push({
        role: msg.role as 'user' | 'assistant',
        content: cleanContent,
      });
    }
  }

  return result;
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

  // Set server logger for background tasks
  serverLog = server.log;

  // Cleanup old completed sessions (older than 24 hours)
  cleanupOldCompletedSessions();

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
      log('Extended cache: timer stopped');
    }

    // 2. Clear sensitive cache data
    if (extendedCache.size > 0) {
      log(`Extended cache: clearing ${extendedCache.size} entries`);
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
