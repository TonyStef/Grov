# Bug: Claude Code Retry Loop Causing Usage Explosion

## Summary

When using Grov proxy with Claude Code, users experienced massive usage spikes (e.g., 76% to 84% in a single session). Investigation revealed that blocking Haiku calls in Grov's request/response processing were causing Claude Code to timeout and retry requests multiple times.

---

## Root Cause Analysis

### Claude Code's HTTP Behavior

From research in the [Claude Code GitHub repository](https://github.com/anthropics/claude-code):

| Parameter | Value | Source |
|-----------|-------|--------|
| `stream` | `false` | [Issue #1771](https://github.com/anthropics/claude-code/issues/1771) |
| HTTP timeout | 60 seconds | Debug logs in issues |
| Max retries | 10 | [Issue #2728](https://github.com/anthropics/claude-code/issues/2728) |
| Backoff | Exponential (1s, 2s, 5s, 9s, 17s...) | Issue reports |

Key finding: Claude Code sends `stream: false` and waits up to 60 seconds for a complete HTTP response. After timeout, it automatically retries up to 10 times.

### Grov's Blocking Operations

Grov proxy performs several LLM calls (Haiku) during request/response processing:

**In `preProcessRequest` (before forwarding to Anthropic):**
- `checkDrift()` - when session is in drifted mode
- `generateForcedRecovery()` - when escalation >= 3

**In `postProcessResponse` (after Anthropic responds):**
- `analyzeTaskContext()` - task orchestration
- `extractIntent()` - on new_task/subtask
- `checkDrift()` - every N prompts
- `saveToTeamMemory()` with `extractReasoningAndDecisions()`

Each Haiku call takes 500-2000ms. Multiple calls can add 5-10 seconds to the total response time.

### The Problem

```
Timeline (problematic):

0s      Claude Code sends request to Grov
        |
        v
0-50s   Grov forwards to Anthropic, waits for response
        |
        v
50s     Anthropic responds to Grov
        |
        v
50-58s  Grov runs postProcessResponse:
        - analyzeTaskContext() ... 2s
        - extractIntent() ... 1s
        - checkDrift() ... 1s
        - createStep() ... 0.5s
        |
        v
58s     Grov finally returns response to Claude Code

Total: 58 seconds (OK, under 60s limit)
```

But when Anthropic is slower:

```
Timeline (failure):

0s      Claude Code sends request
        |
55s     Anthropic responds (slow day)
        |
55-65s  Grov runs postProcessResponse (10s of Haiku calls)
        |
60s     TIMEOUT! Claude Code doesn't receive response
        |
        v
        Claude Code RETRIES (attempt 2/10)
        |
        v
        Same cycle repeats...
        |
        v
        10 retries x API calls = USAGE EXPLOSION
```

### Evidence

Database showed duplicate steps with identical reasoning:
```
23:51:30|edit  |Planul complet a fost salvat...
23:51:41|glob  |Planul complet a fost salvat...
23:55:56|read  |Planul complet a fost salvat...
23:56:09|bash  |Planul complet a fost salvat...
```

Same reasoning text appearing multiple times = multiple retries processing the same response.

---

## Solutions Considered

### 1. Streaming Passthrough

Convert proxy to handle SSE streaming: forward chunks immediately as they arrive from Anthropic.

**Pros:** Solves timeout completely, better UX
**Cons:** 2-3 hours implementation, Claude Code uses `stream: false`

### 2. Send Fake Tool Use Response

Immediately respond with a fake `tool_use` to reset timeout, then send real response.

**Pros:** Creative workaround
**Cons:** HTTP is request-response (can't send two responses), would corrupt conversation history

### 3. Enable Streaming via Settings

Configure Claude Code to use `stream: true` via settings.json.

**Pros:** Would enable ping events
**Cons:** Not supported - no such setting exists in Claude Code

### 4. Fire-and-Forget (CHOSEN)

Return response to Claude Code immediately after Anthropic responds. Run all Haiku processing in background.

**Pros:**
- Simple implementation (~1 hour)
- Eliminates blocking completely
- No changes to Claude Code required
- Drift correction still works (delayed by 1 request)

**Cons:**
- Drift correction is applied on N+1 request instead of N
- If postProcess fails, errors only visible in logs

---

## Chosen Solution: Fire-and-Forget

### Why This Works

None of the operations in `postProcessResponse` affect the current response:

| Operation | Affects Current Response? | Affects Next Request? |
|-----------|---------------------------|----------------------|
| `analyzeTaskContext()` | No | Yes (session state) |
| `extractIntent()` | No | Yes (session goals) |
| `checkDrift()` | No | Yes (drift detection) |
| `createStep()` | No | Yes (step history) |
| `buildCorrection()` | No | Yes (correction injection) |

The response to Claude Code is already complete from Anthropic. Grov only reads and saves data for future use.

### Implementation Plan

#### Change 1: Fire-and-forget postProcessResponse

**File:** `src/proxy/server.ts`

```typescript
// BEFORE (blocking)
if (result.statusCode === 200 && isAnthropicResponse(result.body)) {
  await postProcessResponse(result.body, sessionInfo, request.body, logger);
}
return reply.status(result.statusCode).send(JSON.stringify(result.body));

// AFTER (fire-and-forget)
if (result.statusCode === 200 && isAnthropicResponse(result.body)) {
  postProcessResponse(result.body, sessionInfo, request.body, logger)
    .catch(err => console.error('[GROV] postProcess error:', err));
}
return reply.status(result.statusCode).send(JSON.stringify(result.body));
```

#### Change 2: Pre-compute drift correction

Instead of calling Haiku in `preProcessRequest` to build corrections, we pre-compute them in `postProcessResponse` and store in the database.

**Schema change:**
```sql
ALTER TABLE session_states ADD COLUMN pending_correction TEXT;
```

**In postProcessResponse (background):**
```typescript
if (driftResult.score < 8) {
  const correction = buildCorrection(driftResult, sessionState, level);
  const correctionText = formatCorrectionForInjection(correction);

  await updateSessionState(sessionId, {
    session_mode: 'drifted',
    pending_correction: correctionText
  });
}
```

**In preProcessRequest (sync, fast):**
```typescript
// No Haiku calls - just read and inject
if (sessionState?.pending_correction) {
  appendToSystemPrompt(modified, sessionState.pending_correction);
  await updateSessionState(sessionId, { pending_correction: null });
}
```

#### Change 3: Remove blocking Haiku calls from preProcessRequest

Current code in `preProcessRequest` calls:
- `checkDrift()` - when session_mode is 'drifted'
- `generateForcedRecovery()` - when escalation >= 3

These should use cached/pre-computed values instead of making new Haiku calls.

---

## Files to Modify

| File | Changes |
|------|---------|
| `src/proxy/server.ts` | Fire-and-forget postProcess, remove Haiku from preProcess |
| `src/lib/store.ts` | Add `pending_correction` column and functions |

---

## Testing

After implementation:

1. Run proxy: `grov proxy`
2. Use Claude Code with a complex query
3. Monitor proxy output for timing
4. Verify no retry messages in Claude Code
5. Check database for proper step recording

---

## References

- [Issue #2728 - API Timeout Retry](https://github.com/anthropics/claude-code/issues/2728)
- [Issue #1771 - Request Structure](https://github.com/anthropics/claude-code/issues/1771)
- [Issue #5615 - Timeout Configuration](https://github.com/anthropics/claude-code/issues/5615)
- [Issue #8698 - 10s Connection Timeout](https://github.com/anthropics/claude-code/issues/8698)
