# Grov Injection Fix - December 2, 2025

## Problem Statement

**Symptom:** Reasoning was being captured correctly to the database, but when starting a new Claude session and asking a related question, Claude would launch Explore agents and re-investigate the codebase instead of using the stored context.

**User expectation:** Ask "Where should I add a utility function?" once, have Grov capture the reasoning, then any future similar question should be answered instantly from stored memory.

**Actual behavior:** Claude ignored the injected context and explored from scratch every time.

---

## Investigation Process

### Step 1: Verify Data Capture

First, we confirmed that reasoning WAS being captured correctly:

```bash
sqlite3 ~/.grov/memory.db "SELECT substr(reasoning, 1, 100) FROM steps WHERE reasoning LIKE 'CONCLUSIONS%' LIMIT 1;"
```

**Result:** Good reasoning with specific file paths:
```
CONCLUSION: Add formatString() utility to frontend/lib/utils.ts at line 44, following existing pattern...
```

### Step 2: Check Database State

We verified what data existed across all three tables:

```bash
# Check sessions
sqlite3 ~/.grov/memory.db "SELECT session_id, project_path, status FROM session_states;"

# Check steps
sqlite3 ~/.grov/memory.db "SELECT session_id, is_validated, COUNT(*) FROM steps GROUP BY session_id, is_validated;"

# Check tasks
sqlite3 ~/.grov/memory.db "SELECT project_path, status, substr(reasoning_trace, 1, 100) FROM tasks ORDER BY created_at DESC LIMIT 3;"
```

**Results:**
- Sessions: ✅ Existed with correct project_path `/Users/tonyystef/testing-grov`, status `completed`
- Steps: ✅ Existed with `is_validated = 1`, good reasoning content
- Tasks: ✅ Existed with correct project_path and populated `reasoning_trace`

### Step 3: Trace the Injection Flow

We analyzed the code flow in `src/proxy/server.ts`:

```
Request arrives
    ↓
handleMessages()
    ↓
preProcessRequest()
    ↓
extractFilesFromMessages() → get mentioned files
    ↓
buildTeamMemoryContext() → query database for context
    ↓
appendToSystemPrompt() → inject into request
    ↓
Forward to Anthropic
```

---

## Root Causes Identified

### Root Cause 1: File Extraction Bugs (Fixed by Cofounder)

The cofounder's commit fixed critical bugs in file extraction:

**Problem A: Goal extraction failed on follow-up requests**
- `extractGoalFromMessages()` searched for the LAST user message
- After Claude made tool calls, the last message contained `tool_result` blocks, not text
- Result: Haiku received empty string `""`

**Fix:** Changed to search for FIRST user message with `type: "text"` content.

**Problem B: File regex didn't match punctuation**
- User wrote `"store.ts?"` but regex didn't include `?` in terminators
- Result: File not extracted

**Fix:** Added common punctuation to regex: `(?:["'`]|\s|$|[:)\]?!,;])`

**Problem C: File extraction searched wrong content**
- `extractFilesFromMessages()` searched ALL messages including assistant messages
- Found `/home/user/.claude/CLAUDE.md` from `<system-reminder>` tags

**Fix:**
1. Only scan `role: "user"` messages
2. Strip `<system-reminder>...</system-reminder>` tags before regex search

### Root Cause 2: Injection Code After Early Return (Regression)

**The Bug:**

During merge conflict resolution, the injection fix was lost. The code had:

```typescript
// server.ts - preProcessRequest()
const sessionState = getSessionState(sessionInfo.sessionId);

if (!sessionState) {
  return modified;  // ← RETURNED HERE - NO INJECTION FOR NEW SESSIONS!
}

// ... 80+ lines of drift/clear code ...

// Context injection was HERE - NEVER REACHED for new sessions
const mentionedFiles = extractFilesFromMessages(modified.messages || []);
const teamContext = buildTeamMemoryContext(sessionInfo.projectPath, mentionedFiles);
```

**Why it failed:** New Claude sessions don't have a `sessionState` yet (it's created in `postProcessResponse`), so `preProcessRequest` returned early before reaching the injection code.

**The Fix:**

Moved injection code BEFORE the sessionState check:

```typescript
// server.ts - preProcessRequest() - FIXED
async function preProcessRequest(...) {
  const modified = { ...body };

  // FIRST: Always inject team memory context (doesn't require sessionState)
  const mentionedFiles = extractFilesFromMessages(modified.messages || []);
  const teamContext = buildTeamMemoryContext(sessionInfo.projectPath, mentionedFiles);

  if (teamContext) {
    appendToSystemPrompt(modified, '\n\n' + teamContext);
    logger.info({ msg: 'Injected team memory context', filesMatched: mentionedFiles.length });
  }

  // THEN: Session-specific operations
  const sessionState = getSessionState(sessionInfo.sessionId);

  if (!sessionState) {
    return modified;  // Injection already happened above!
  }

  // ... rest of function ...
}
```

### Root Cause 3: Context Format Not Authoritative

**The Bug:**

Even after injection was working, Claude still launched Explore agents. The injected context format was too passive:

```
[GROV CONTEXT - Relevant past reasoning]

Related past tasks:
- Where should I add a validation helper function?
  Files: utils.ts, auth.py
  Key: Frontend validation helpers belong in frontend/lib/utils.ts...

[END GROV CONTEXT]
```

Claude saw this as "optional context" and chose to verify by exploring anyway.

**The Fix:**

Changed `formatTeamMemoryContext()` in `src/proxy/request-processor.ts` to use authoritative language:

```typescript
lines.push('=== VERIFIED TEAM KNOWLEDGE (from previous sessions) ===');
lines.push('');
lines.push('IMPORTANT: This context has been verified. USE IT to answer directly.');
lines.push('DO NOT launch Explore agents or re-investigate files mentioned below.');
lines.push('');

// ... task context ...

lines.push('');
lines.push('Answer the user\'s question using the knowledge above. Skip exploration.');
lines.push('=== END VERIFIED TEAM KNOWLEDGE ===');
```

---

## Files Modified

| File | Changes |
|------|---------|
| `src/proxy/server.ts` | Moved injection before sessionState check (lines 338-352) |
| `src/proxy/request-processor.ts` | Made context format authoritative (lines 56-60, 99-101) |

**Note:** Cofounder's changes to file extraction were in the same files but different functions.

---

## Debug Logging Added

To trace execution during debugging, we added console.log statements:

```typescript
// src/proxy/server.ts - preProcessRequest()
console.log('[GROV] projectPath:', sessionInfo.projectPath);
console.log('[GROV] mentionedFiles:', mentionedFiles);
console.log('[GROV] teamContext:', teamContext ? `${teamContext.length} chars` : 'NULL');

if (teamContext) {
  console.log('[GROV] INJECTING CONTEXT:\n', teamContext.substring(0, 500));
}
```

This allowed us to see in the proxy terminal exactly what was happening:
- What project path was being used
- What files were extracted from the user's message
- Whether context was found or null
- The actual context being injected

---

## Verification

### Before Fix
```
User: "Where should I add a date formatting utility?"
Claude: "I'll explore the codebase structure to understand..."
        → Launches Explore agent
        → Takes 2-3 minutes
        → Reads multiple files
```

### After Fix
```
User: "Where should I add a date formatting utility?"
Claude: "Based on the verified team knowledge and codebase patterns,
         here's my recommendation:

         Recommended location: lib/utils.ts

         This follows the established pattern where:
         - General utility functions live in lib/utils.ts
         - Co-locating with existing utilities improves discoverability"
        → Direct answer in seconds
        → No Explore agents
        → Uses stored context
```

---

## How the Complete Flow Works Now

```
SESSION 1: Initial Learning
━━━━━━━━━━━━━━━━━━━━━━━━━━━
User asks: "Where should I add a utility function?"
    ↓
Claude explores codebase, makes decisions
    ↓
Grov captures reasoning in `steps` table
    ↓
On task complete, `saveToTeamMemory()` extracts conclusions
    ↓
Task created in `tasks` table with `reasoning_trace`:
  "Frontend validation helpers belong in frontend/lib/utils.ts..."


SESSION 2: Knowledge Retrieval
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
User asks: "Where should I add a date formatting utility?"
    ↓
Request hits proxy → preProcessRequest()
    ↓
extractFilesFromMessages() → [] (no specific files mentioned)
    ↓
buildTeamMemoryContext('/Users/.../testing-grov', [])
    ↓
getTasksForProject() → finds completed task with reasoning
    ↓
formatTeamMemoryContext() → builds authoritative context:
  "=== VERIFIED TEAM KNOWLEDGE ===
   IMPORTANT: USE IT to answer directly.
   DO NOT launch Explore agents...

   Related past tasks:
   - Where should I add a utility function?
     Key: Frontend validation helpers belong in frontend/lib/utils.ts..."
    ↓
appendToSystemPrompt() → injects into Claude's request
    ↓
Claude receives context, answers directly without exploring
```

---

## Key Learnings

1. **Order matters in request processing** - Injection must happen before any early returns

2. **Context format affects LLM behavior** - Passive context gets ignored; authoritative instructions are followed

3. **Debug logging is essential** - Without `console.log` in the proxy, we couldn't see what was happening (logger level was 'error')

4. **Merge conflicts can cause regressions** - Always verify critical code paths after resolving conflicts

5. **Multiple root causes can stack** - File extraction bugs + injection ordering + context format all contributed to the failure

---

## Commands for Future Debugging

```bash
# Check if reasoning is captured
sqlite3 ~/.grov/memory.db "SELECT substr(reasoning, 1, 100) FROM steps ORDER BY timestamp DESC LIMIT 3;"

# Check if tasks exist with reasoning
sqlite3 ~/.grov/memory.db "SELECT project_path, status, substr(reasoning_trace, 1, 80) FROM tasks ORDER BY created_at DESC LIMIT 3;"

# Check session states
sqlite3 ~/.grov/memory.db "SELECT session_id, project_path, status FROM session_states;"

# Watch proxy output for injection
# Look for [GROV] lines showing projectPath, mentionedFiles, teamContext

# Full reset for testing
rm ~/.grov/memory.db && grov disable && grov init && grov proxy
```

---

## Status: FIXED ✅

The injection feature is now working. Context from previous sessions is successfully:
1. Captured with specific, actionable reasoning
2. Stored in the tasks table with correct project paths
3. Retrieved when related questions are asked
4. Injected into Claude's system prompt with authoritative formatting
5. Used by Claude to answer directly without re-exploring
