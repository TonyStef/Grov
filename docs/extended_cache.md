# Extended Cache Feature

> **Last updated:** Dec 2025 - Verified against actual implementation in `proxy_local` branch.

Technical specification for the extended cache feature that preserves Anthropic's prompt cache during user idle periods.

---

## Files Overview

### Files to Modify

- `src/proxy/config.ts` - Add EXTENDED_CACHE_ENABLED configuration
- `src/proxy/server.ts` - Main implementation: cache Map, capture logic, timer, cleanup
- `src/cli.ts` - Add --extended-cache CLI flag
- `.env.example` - Document GROV_EXTENDED_CACHE environment variable

### Files to Create

- None required. All implementation fits within existing architecture.

---

## Overview

### The Problem

Anthropic's prompt cache has a 5-minute TTL (Time To Live). When developers pause to analyze Claude's output, they risk exceeding this window. The next prompt then triggers full cache recreation, which:
- Costs significantly more (cache_creation is 1.25x base price vs cache_read at 0.1x)
- Counts against ITPM rate limits (cache_creation counts, cache_read does not)
- Adds latency for cache rebuild

### The Solution

Grov proxy sends minimal "keep-alive" requests during idle periods to refresh the cache TTL without meaningful token usage. This preserves the cache for when the user returns.

### Why This Approach

- Transparent to user (opt-in, runs in background)
- Minimal cost (~$0.002 per keep-alive)
- No conversation pollution (keep-alive responses are discarded)
- Cache prefix matching preserved (we send exact same prefix + minimal message)

---

## Technical Design

### Cache Storage

```typescript
interface ExtendedCacheEntry {
  headers: Record<string, string>;  // Safe headers via buildSafeHeaders (x-api-key, authorization, anthropic-version, etc.)
  rawBody: Buffer;                  // Exact request bytes for prefix matching
  timestamp: number;                // Last activity (for idle calculation)
  keepAliveCount: number;           // Track attempts (max 2)
}

const extendedCache = new Map<string, ExtendedCacheEntry>();
```

**Note:** We store the full headers object (via `buildSafeHeaders()` from config.ts) instead of just authorization. This ensures keep-alive uses identical headers as the original request.

### Timing Logic

- Timer interval: 60 seconds (check all sessions)
- Idle threshold: 4 minutes (just under 5-min TTL) - **TEMP: 1 minute for testing**
- Max keep-alives: 2 per idle period
- Total max idle: ~10 minutes before cleanup

**Constant definitions in code:**
```typescript
const EXTENDED_CACHE_IDLE_THRESHOLD = 4 * 60 * 1000;  // 4 minutes (change to 1 min for testing)
const EXTENDED_CACHE_MAX_IDLE = 10 * 60 * 1000;       // 10 minutes
const EXTENDED_CACHE_MAX_KEEPALIVES = 2;
```

### Keep-Alive Request Structure

```
Original cached content (UNCHANGED):
  - system (with cache_control)
  - tools (with cache_control)
  - max_tokens (UNCHANGED - preserves prefix)
  - stream (UNCHANGED - preserves prefix)
  - messages (conversation history)

Added for keep-alive:
  - user message: "." (appended to messages array)
```

**CRITICAL: Do NOT modify max_tokens or stream!**

Anthropic cache uses **byte-exact prefix matching**. If we change max_tokens or stream (which appear before cached content in JSON), the prefix changes and cache_read=0.

The "." message:
- Is AFTER the cache breakpoint (does not affect cached prefix)
- Claude responds briefly (~10-50 tokens)
- Response is discarded (not added to conversation)

### CRITICAL: Raw String Manipulation

**DO NOT use JSON.parse/JSON.stringify!** This breaks cache.

The problem: `JSON.stringify()` removes whitespace, changing byte sequence. Anthropic cache uses PREFIX MATCHING - even 1 byte difference = cache MISS.

Solution: Manipulate raw body as string:

```typescript
let rawBodyStr = entry.rawBody.toString('utf-8');

// 1. Find messages array closing bracket, insert message before it
const keepAliveMsg = ',{"role":"user","content":"."}';
rawBodyStr = rawBodyStr.slice(0, messagesEnd) + keepAliveMsg + rawBodyStr.slice(messagesEnd);

// NOTE: Do NOT modify max_tokens or stream!
// Keeping them identical preserves the cache prefix for byte-exact matching.
```

**Always validate JSON after manipulation:**
```typescript
try {
  JSON.parse(rawBodyStr);  // Validate only, don't use result
} catch (e) {
  throw new Error('Invalid JSON after modifications');
}
```

---

## Implementation Plan

### 1. Configuration (config.ts) ✅ DONE

Add new configuration option:

```typescript
EXTENDED_CACHE_ENABLED: process.env.GROV_EXTENDED_CACHE === 'true',
```

Security note: Feature is disabled by default. Requires explicit opt-in.

**Executed:** Added `EXTENDED_CACHE_ENABLED` to config object at line 30.

### 2. CLI Flag (cli.ts) ✅ DONE

Add --extended-cache flag to proxy command:

```typescript
program
  .command('proxy')
  .option('--extended-cache', 'Enable extended cache to preserve Anthropic prompt cache during idle')
```

When flag is present, set environment variable before starting server.

**Executed:** Added `--extended-cache` option at line 87, sets `GROV_EXTENDED_CACHE=true` before importing server.

### 3. Cache Storage (server.ts) ✅ DONE

Add new Map after existing Maps (around line 90):

```typescript
interface ExtendedCacheEntry {
  headers: Record<string, string>;  // Safe headers via buildSafeHeaders()
  rawBody: Buffer;
  timestamp: number;
  keepAliveCount: number;
}

const extendedCache = new Map<string, ExtendedCacheEntry>();
```

**Executed:** Added `ExtendedCacheEntry` interface and `extendedCache` Map at lines 90-97.

### 4. Capture After Response (server.ts) ✅ DONE

Location: In postProcessResponse, after successful end_turn response.

Trigger condition:
- EXTENDED_CACHE_ENABLED is true
- response.stop_reason === 'end_turn'
- extendedCacheData provided (contains headers and rawBody)

Implementation:
- Extract safe headers via `buildSafeHeaders()` from config.ts
- Store rawBody (the exact bytes sent to Anthropic)
- Set timestamp to Date.now()
- Set keepAliveCount to 0

Why after end_turn (not after forward):
- Task processing can take minutes (tool_use loops)
- Timer measures USER idle time, not Anthropic processing time
- Starting timer after end_turn ensures we measure actual idle period

**Executed:**
- Added `extendedCacheData` parameter to postProcessResponse (line 1060)
- Call site prepares cacheData with `buildSafeHeaders(request.headers)` (lines 742-747)
- Cache capture at lines 1090-1099 stores to extendedCache Map on end_turn

### 5. Timer Implementation (server.ts) ✅ DONE

Start interval when server starts (store reference for cleanup!):

```typescript
let extendedCacheTimer: NodeJS.Timeout | null = null;

if (config.EXTENDED_CACHE_ENABLED) {
  extendedCacheTimer = setInterval(checkExtendedCache, 60_000);
}
```

Check function logic:
```
For each session in extendedCache:
  - Calculate idle time: now - timestamp
  - If idle > 10 minutes: delete (stale)
  - If idle < threshold: skip (user active)
  - If keepAliveCount >= 2: delete (max retries)
  - Otherwise: collect for keep-alive

Send all keep-alives in PARALLEL via Promise.all
```

**CRITICAL: Use Promise.all for parallel execution** - sequential awaits cause cascading delays with many sessions.

```typescript
const keepAlivePromises: Promise<void>[] = [];
for (const { sessionId, entry } of sessionsToKeepAlive) {
  keepAlivePromises.push(sendExtendedCacheKeepAlive(sessionId, entry)...);
}
await Promise.all(keepAlivePromises);
```

**Executed:**
- Added timing constants at lines 100-102
- Created checkExtendedCache() at lines 211-269 with parallel execution
- Timer started in startServer() at lines 1846-1850

### 6. Keep-Alive Request Function (server.ts) ✅ DONE

Function: sendExtendedCacheKeepAlive(sessionId, entry)

Steps:
1. Convert rawBody to string (DO NOT parse as JSON!)
2. Use raw string manipulation to add "." message before messages array closing bracket
3. Replace max_tokens with 5 via regex
4. Force stream:false
5. Validate JSON (parse only, don't use result)
6. Forward to Anthropic using `forwardToAnthropic()` (same undici path as regular requests)
7. Discard response (we only care about cache refresh side effect)
8. On success: update timestamp, increment keepAliveCount (done in caller)
9. On error: throw (caller catches and deletes from cache)

**CRITICAL: Use forwardToAnthropic(), NOT native fetch!**
- Same HTTP client (undici) as regular request forwarding
- Same header handling
- Avoids 401 errors from header format differences

```typescript
const result = await forwardToAnthropic(
  {},  // body not used when rawBody is provided
  entry.headers,
  undefined,  // no logger
  Buffer.from(rawBodyStr, 'utf-8')
);
```

**Executed:** Created sendExtendedCacheKeepAlive() at lines 109-204. Uses forwardToAnthropic with raw string manipulation.

### 7. Collision Handling (server.ts) ✅ DONE

Location: In handleMessages, when new request arrives.

Logic:
- If session exists in extendedCache: overwrite with new data
- This resets timestamp and keepAliveCount
- Effect: active user never gets keep-alive sent (timestamp always recent)

**Executed:** Implicitly handled by `extendedCache.set()` in postProcessResponse - it overwrites any existing entry automatically, resetting timestamp and keepAliveCount to 0.

### 8. Cleanup Logic (server.ts) ✅ DONE

Multiple cleanup triggers:

a) Stale cleanup (in timer):
   - If idle > 10 minutes total: delete entry
   - User definitely left, no point keeping data

b) After max retries:
   - If keepAliveCount >= 2 and still idle: delete entry
   - We tried twice, user is gone

c) On error:
   - Any error in keep-alive: delete entry
   - Fail safe, don't retry broken sessions

d) On shutdown (CRITICAL for clean exit):
   - **clearInterval(extendedCacheTimer)** - stop timer first!
   - Clear sensitive data in each entry (headers, rawBody)
   - Clear entire Map
   - Close server and exit

**CRITICAL: Must call clearInterval on shutdown!**
Without this, setInterval keeps Node.js process alive after Ctrl+C.

```typescript
const cleanupExtendedCache = () => {
  if (extendedCacheTimer) {
    clearInterval(extendedCacheTimer);
    extendedCacheTimer = null;
  }
  // Clear sensitive data...
  extendedCache.clear();
  server.close().then(() => process.exit(0));
};

process.on('SIGTERM', cleanupExtendedCache);
process.on('SIGINT', cleanupExtendedCache);
```

**Executed:**
- a, b, c: Implemented in checkExtendedCache() at lines 218-238
- d: Shutdown handlers with clearInterval at lines 1853-1888

### 9. Logging (server.ts) ✅ DONE

Log events (without sensitive data):
- "Extended cache: stored session {id}"
- "Extended cache: keep-alive sent for session {id}"
- "Extended cache: cleared session {id} (reason: {reason})"

Never log:
- authorization header
- rawBody contents
- Any user data

**Executed:** All logs use only first 8 chars of sessionId and generic reasons. No sensitive data logged:
- postProcessResponse: `logger.info({ msg: 'Extended cache: stored session', sessionId: ...substring(0,8) })`
- checkExtendedCache: `console.log()` for background task logs (stale/max retries/errors)
- startServer shutdown: `console.log()` for entry count only

---

## Security Analysis

### Concern: Storing API Key in Memory

Discussion: Initial concern was that storing API keys in plaintext memory is insecure.

Research findings:
- Memory-only storage (no disk) is standard practice for proxies
- Major cloud providers (GCP, AWS, Azure) provide strong process isolation via hypervisor
- Cross-tenant memory access is essentially impossible in properly configured cloud
- The API key is ALREADY in memory during normal request forwarding
- Extended cache only increases duration (seconds to minutes), not exposure type

Resolution: Proceed with plaintext memory storage. The security boundary is the cloud VM/container isolation, not encryption within the process.

### Concern: Encryption in Memory

Discussion: Considered encrypting API key in memory with per-session key.

Analysis:
- Encryption requires decryption before use
- During decryption, plaintext exists in memory anyway
- Attacker with memory access (RCE) can hook decrypt function
- Encryption adds complexity without meaningful security gain against active attackers

Resolution: Do not implement memory encryption. It provides false sense of security and adds attack surface through additional code.

### Concern: Core Dumps

Discussion: Could memory contents leak through core dumps?

Analysis:
- Cloud containers typically have core dumps disabled by default
- Cloud storage is encrypted at rest (GCP, AWS, Azure)
- Can explicitly disable with ulimit -c 0 if needed
- Low risk in production cloud environment

Resolution: Not a significant concern for cloud deployment. Document that self-hosted users should disable core dumps if concerned.

### Concern: Using User's API Key Without Explicit Action

Discussion: Is it ethical/allowed to make requests using user's API key for keep-alive?

Analysis:
- Feature requires explicit opt-in (--extended-cache flag)
- User is informed what the feature does
- Similar tools exist (Autocache on GitHub does similar cache optimization)
- Anthropic's terms don't prohibit proxy caching/optimization
- User benefits from cost savings

Resolution: Proceed with opt-in model. Clear documentation about what the feature does and its costs.

### Concern: Rate Limits

Discussion: Could keep-alive requests push user over rate limits?

Analysis:
- cache_read_input_tokens do NOT count toward ITPM limit
- Only cache_creation_input_tokens and input_tokens count
- Keep-alive generates mostly cache_read (good) with minimal input_tokens
- Actually HELPS rate limits by preventing cache recreation

Resolution: Feature helps rather than hurts rate limits. No concern.

### Concern: Request Timing and Collisions

Discussion: What if keep-alive is sent while user is typing?

Analysis:
- Timer only fires after 4 minutes of idle
- New user request immediately overwrites cache entry (resets timestamp)
- Keep-alive check verifies idle time before sending
- Race condition window is minimal (timer runs every 60s)

Resolution: Collision handling via timestamp check and overwrite is sufficient.

---

## Cost Analysis

TODO: After implementation is complete and tested, add tracking to measure actual impact:

- Track cache_creation_input_tokens vs cache_read_input_tokens per session
- Compare sessions with extended cache enabled vs disabled
- Measure actual savings in longer conversations (30+ min sessions)
- Log keep-alive frequency and success rate
- Calculate real-world cost/benefit ratio

This data will help validate the feature's effectiveness and fine-tune timing parameters.

---

## Configuration Reference

### Environment Variables

```bash
# Enable extended cache feature
GROV_EXTENDED_CACHE=true
```

### CLI Usage

```bash
# Start proxy with extended cache enabled
grov proxy --extended-cache
```

### Documentation for Users

When enabled, Grov sends up to 2 minimal keep-alive requests during idle periods (approximately every 4 minutes) to preserve Anthropic's prompt cache. This:
- Saves money by avoiding cache recreation (~$0.18 savings per idle period)
- Reduces latency on next request
- Costs approximately $0.002 per keep-alive
- Requires your requests to pass through Grov proxy
- Is completely optional and disabled by default

---

## Testing Checklist

- [x] Verify cache entry created after end_turn
- [x] Verify keep-alive sent after idle threshold
- [x] Verify keep-alive not sent if user active (timestamp recent)
- [x] Verify max 2 keep-alives per idle period
- [x] Verify cleanup after 10 minutes total idle
- [x] Verify cache overwrite on new user request
- [x] Verify cleanup on shutdown signals (including clearInterval)
- [x] Verify no sensitive data in logs (API keys masked)
- [x] Verify feature disabled by default
- [x] Verify --extended-cache flag works
- [x] Verify GROV_EXTENDED_CACHE env var works
- [x] Verify cache_read tokens in keep-alive response (not cache_creation)

---

## Database Agnostic

**This feature does NOT touch the database.** It uses only in-memory storage (`extendedCache` Map).

Works identically on:
- SQLite (proxy_local branch)
- PostgreSQL (postgres branch)

No migrations or schema changes required.

---

## Bugs Fixed During Implementation

### 1. JSON Re-serialization Breaks Cache (CRITICAL)
- **Problem:** JSON.parse → JSON.stringify removes whitespace → different bytes → cache MISS every time
- **Symptom:** cache_creation tokens instead of cache_read on keep-alive
- **Fix:** Raw string manipulation without parsing

### 2. Native fetch vs undici (401 Unauthorized)
- **Problem:** Using `fetch()` with headers formatted differently than undici causes Anthropic to reject
- **Symptom:** 401 "OAuth not supported" error
- **Fix:** Use `forwardToAnthropic()` which uses same undici client as regular requests

### 3. setInterval Keeps Process Alive (Ctrl+C hangs)
- **Problem:** setInterval reference not cleared on shutdown
- **Symptom:** Ctrl+C doesn't exit cleanly, process hangs
- **Fix:** Store timer reference, call `clearInterval()` in shutdown handler

### 4. Sequential Awaits (Slow with Many Sessions)
- **Problem:** `for...of` with `await` processes sessions one-by-one
- **Symptom:** N sessions × latency = very slow timer cycle
- **Fix:** Collect promises, use `Promise.all()` for parallel execution

### 5. API Key Exposed in Logs
- **Problem:** Debug logs showed full authorization header
- **Fix:** Mask sensitive headers before logging: `header.substring(0, 20) + '...'`

### 6. Modifying max_tokens/stream Breaks Cache Prefix (CRITICAL)
- **Problem:** Changing max_tokens to 5 and stream to false altered the byte prefix
- **Symptom:** keep-alive always got cache_read=0 (prefix mismatch)
- **Fix:** Do NOT modify max_tokens or stream - only append "." message to messages array

---

## Current Status

**Implementation complete.** Tested successfully with:
- cache_read tokens on keep-alive (cache preserved!)
- Clean shutdown via Ctrl+C
- Parallel execution with multiple sessions
- IDLE_THRESHOLD = 4 minutes (production)

**Debug logs still enabled** - can be removed when stable.
- Monitor real-world cost/benefit ratio
