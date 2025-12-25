// Extended Cache - Keep Anthropic cache alive during idle
// Sends minimal keep-alive requests to prevent cache TTL expiration

import { forwardToAnthropic, isForwardError } from '../agents/claude/forwarder.js';

export interface ExtendedCacheEntry {
  headers: Record<string, string>;  // Safe headers via buildSafeHeaders()
  rawBody: Buffer;                  // Exact request bytes for prefix matching
  timestamp: number;                // Last activity (for idle calculation)
  keepAliveCount: number;           // Track attempts (max 2)
}

export const extendedCache = new Map<string, ExtendedCacheEntry>();

// Timing constants
const EXTENDED_CACHE_IDLE_THRESHOLD = 4 * 60 * 1000;  // 4 minutes (under 5-min TTL)
const EXTENDED_CACHE_MAX_IDLE = 10 * 60 * 1000;       // 10 minutes total
const EXTENDED_CACHE_MAX_KEEPALIVES = 2;
const EXTENDED_CACHE_MAX_ENTRIES = 100;               // Max concurrent sessions (memory cap)

export function log(msg: string): void {
  console.log(`[CACHE] ${msg}`);
}

export function evictOldestCacheEntry(): void {
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
    // Evicted silently - capacity limit
  }
}

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

  // Sending keep-alive - result logged after response

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

  // 3. Forward to Anthropic using same undici path as regular requests
  const result = await forwardToAnthropic(
    {},
    entry.headers as Record<string, string | string[] | undefined>,
    undefined,
    Buffer.from(rawBodyStr, 'utf-8')
  );

  if (result.statusCode !== 200) {
    throw new Error(`Keep-alive failed: ${result.statusCode}`);
  }

}

export async function checkExtendedCache(): Promise<void> {
  const now = Date.now();
  const projectsToKeepAlive: Array<{ projectPath: string; entry: ExtendedCacheEntry }> = [];

  // First pass: cleanup stale/maxed entries, collect projects needing keep-alive
  for (const [projectPath, entry] of extendedCache) {
    const idleTime = now - entry.timestamp;
    const projectName = projectPath.split('/').pop() || projectPath;

    // Stale cleanup: user left after 10 minutes
    if (idleTime > EXTENDED_CACHE_MAX_IDLE) {
      extendedCache.delete(projectPath);
      continue;
    }

    // Skip if not idle enough yet
    if (idleTime < EXTENDED_CACHE_IDLE_THRESHOLD) {
      continue;
    }

    // Skip if already sent max keep-alives
    if (entry.keepAliveCount >= EXTENDED_CACHE_MAX_KEEPALIVES) {
      extendedCache.delete(projectPath);
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
        const errMsg = isForwardError(err) ? err.message : (err instanceof Error ? err.message : 'unknown');
        console.error(`[CACHE] keep-alive ${projectName} failed: ${errMsg}`);
      });

    keepAlivePromises.push(promise);
  }

  // Wait for all keep-alives to complete
  if (keepAlivePromises.length > 0) {
    await Promise.all(keepAlivePromises);
  }
}
