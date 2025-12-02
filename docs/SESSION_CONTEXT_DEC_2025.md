# Grov Session Context - December 2, 2025

## READ THIS FIRST

This document contains everything a new Claude Code instance needs to understand the current state of Grov and continue debugging/development.

**Current Status:** Capture works great, injection doesn't work (Claude still explores instead of using injected context).

---

## What is Grov?

Grov is a local proxy for Claude Code that:
1. **Captures** reasoning from Claude sessions (what Claude learned, decided, and why)
2. **Injects** that knowledge into future sessions (so Claude doesn't re-explore)

**The goal:** Ask "Where should I add a utility function?" once, and every future similar question gets answered instantly from stored memory instead of Claude launching explore agents.

**How it works:**
```
Claude Code → localhost:8080 (grov proxy) → api.anthropic.com
                    ↓
          - Injects team memory context into requests
          - Parses Claude's responses (tool_use, text)
          - Extracts reasoning and saves to SQLite
          - Detects task completion
```

---

## What We Fixed This Session

### Fix 1: Reasoning Extraction Was Generic (FIXED ✅)

**Before:** Captured reasoning was useless:
```
"Explored codebase structure"
"I'll explore the current codebase"
```

**After:** Captured reasoning is specific and actionable:
```
"CONCLUSIONS: Frontend validation helpers belong in frontend/lib/utils.ts (general)
or frontend/lib/ subdirectory (domain-specific). Backend validation utilities
belong in backend/app/utils/ directory. Decision rationale: co-locate with
existing utilities (cn, formatDate in frontend/lib/utils.ts; auth.py in
backend/app/utils/)."
```

**Files changed:**

1. **`src/lib/llm-extractor.ts` lines 654-660** - Changed compression prompt:
   ```typescript
   const compressionInstruction = needsCompression
     ? `\n  "step_reasoning": "Extract CONCLUSIONS and SPECIFIC RECOMMENDATIONS only.
        Include: exact file paths (e.g., src/lib/utils.ts), function/component names,
        architectural patterns discovered, and WHY decisions were made.
        DO NOT write process descriptions like 'explored' or 'analyzed'. Max 800 chars."`
     : '';
   ```

2. **`src/lib/llm-extractor.ts` lines 799-852** - Changed extraction prompt with GOOD/BAD examples

3. **`src/proxy/response-processor.ts` lines 66-79** - Added file path extraction from reasoning text

4. **`src/proxy/server.ts` lines 806-835** - Added capture of text-only end_turn responses (Claude's final answers)

**Verification command:**
```bash
sqlite3 ~/.grov/memory.db "SELECT reasoning FROM steps WHERE reasoning LIKE 'CONCLUSIONS%' LIMIT 1;"
# Returns good reasoning with file paths
```

---

### Fix 2: Team Memory Injection Gated Behind sessionState (FIXED ✅)

**The bug:** In `preProcessRequest()`, context injection was AFTER an early return:

```typescript
// OLD CODE - BROKEN
const sessionState = getSessionState(sessionInfo.sessionId);

if (!sessionState) {
  return modified;  // <-- RETURNED HERE on new sessions!
}

// ... 80+ lines of drift/clear code ...

// Team memory injection - NEVER REACHED on first request!
const teamContext = buildTeamMemoryContext(...);
```

**The fix:** Moved team memory injection BEFORE the sessionState check:

```typescript
// NEW CODE - FIXED
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

// ... rest of drift/clear code ...
```

**File:** `src/proxy/server.ts` lines 338-357

---

## What's NOT Working (Current Problem)

### Problem: Claude Still Launches Explore Agents Despite Injection

**Symptom:** Even after all fixes, when asking "Where should I add a string formatting utility?", Claude responds:
```
"I'll explore the codebase to understand the current structure and find where utility functions are organized."
```
Then launches an Explore subagent.

**What we verified:**
- ✅ Tasks ARE stored with correct project_path (`/Users/tonyystef/testing-grov`)
- ✅ Tasks ARE marked as complete with good reasoning_trace
- ✅ Build DOES have the injection fix (verified `dist/proxy/server.js` line 230)
- ✅ Proxy WAS restarted after build
- ✅ User ran full reset: `grov disable && grov init && grov proxy`

**What we DON'T know:**
- ❓ Is `buildTeamMemoryContext()` returning context or `null`?
- ❓ Is `appendToSystemPrompt()` actually being called?
- ❓ Is Claude receiving the context but choosing to ignore it?
- ❓ Is there a projectPath mismatch somewhere?

---

## Next Step: Add Debug Logging

The logger level is `'error'` (line 116 in server.ts), so `logger.info()` doesn't output. Need to add `console.log()` to debug.

**Add this to `src/proxy/server.ts` in `preProcessRequest()` around line 340:**

```typescript
// FIRST: Always inject team memory context (doesn't require sessionState)
const mentionedFiles = extractFilesFromMessages(modified.messages || []);
console.log('[GROV DEBUG] projectPath:', sessionInfo.projectPath);
console.log('[GROV DEBUG] mentionedFiles:', mentionedFiles);

const teamContext = buildTeamMemoryContext(sessionInfo.projectPath, mentionedFiles);
console.log('[GROV DEBUG] teamContext:', teamContext ? `${teamContext.length} chars` : 'NULL');
console.log('[GROV DEBUG] teamContext preview:', teamContext?.substring(0, 300));

if (teamContext) {
  appendToSystemPrompt(modified, '\n\n' + teamContext);
  console.log('[GROV DEBUG] Context injected into system prompt!');
}
```

Then:
1. `npm run build`
2. Restart proxy: `grov proxy`
3. Test with Claude: "Where should I add a utility function?"
4. Check proxy terminal for `[GROV DEBUG]` output

---

## Key Files and Their Roles

| File | Purpose |
|------|---------|
| `src/proxy/server.ts` | Main proxy - handles requests/responses, session management, context injection |
| `src/proxy/request-processor.ts` | `buildTeamMemoryContext()` and `formatTeamMemoryContext()` |
| `src/proxy/response-processor.ts` | `saveToTeamMemory()` - saves completed sessions |
| `src/lib/llm-extractor.ts` | LLM prompts for task analysis, reasoning extraction |
| `src/lib/store.ts` | SQLite database operations |

---

## Database Schema (Key Tables)

**tasks** - Completed task knowledge (the "team memory")
```sql
- id: UUID
- project_path: string (e.g., "/Users/tonyystef/testing-grov")
- original_query: string (what user asked)
- reasoning_trace: JSON array of reasoning strings
- files_touched: JSON array of file paths
- decisions: JSON array of {choice, reason}
- status: 'complete' | 'partial' | 'abandoned'
```

**steps** - Individual actions within a session
```sql
- session_id: UUID (links to session_states)
- action_type: 'edit' | 'write' | 'bash' | 'read' | 'glob' | 'grep' | 'task' | 'other'
- reasoning: string (Claude's explanation)
- files: JSON array
```

**session_states** - Active/completed sessions
```sql
- session_id: UUID
- project_path: string
- original_goal: string
- status: 'active' | 'completed' | 'abandoned'
```

---

## How Context Injection SHOULD Work

1. User asks Claude "Where should I add a utility?"
2. Request goes to proxy's `handleMessages()`
3. `preProcessRequest()` is called
4. `extractFilesFromMessages()` extracts file paths from user message (often empty)
5. `buildTeamMemoryContext(projectPath, mentionedFiles)` queries:
   - `getTasksForProject(projectPath, { status: 'complete' })` - gets completed tasks
   - Returns `null` if no tasks found
6. If context exists, `formatTeamMemoryContext()` builds:
   ```
   [GROV CONTEXT - Relevant past reasoning]

   Related past tasks:
   - Where should I add a validation helper function?
     Files: utils.ts, auth.py
     Key: CONCLUSIONS: Frontend validation helpers belong in frontend/lib/utils.ts...

   [END GROV CONTEXT]
   ```
7. `appendToSystemPrompt()` adds context to request's system prompt
8. Modified request forwarded to Anthropic
9. Claude SHOULD see context and answer from memory

---

## Useful Debug Commands

```bash
# Check what tasks exist
sqlite3 ~/.grov/memory.db "SELECT project_path, substr(original_query, 1, 50), status FROM tasks;"

# Check reasoning quality in steps
sqlite3 ~/.grov/memory.db "SELECT action_type, substr(reasoning, 1, 100) FROM steps ORDER BY timestamp DESC LIMIT 10;"

# Check task reasoning_trace (the gold)
sqlite3 ~/.grov/memory.db "SELECT reasoning_trace FROM tasks WHERE project_path = '/Users/tonyystef/testing-grov' LIMIT 1;"

# Check active sessions
sqlite3 ~/.grov/memory.db "SELECT session_id, status, original_goal FROM session_states;"

# Full test cycle
grov disable && grov init && grov proxy  # Terminal 1
claude  # Terminal 2, ask a question
```

---

## Important Implementation Details

1. **Logger level is 'error'** - In `src/proxy/server.ts` line 116:
   ```typescript
   logger: { level: 'error' }
   ```
   So `logger.info()` produces NO output. Use `console.log()` for debugging.

2. **Proxy must be restarted after builds** - The old Node process keeps running old code.

3. **`grov init` sets ANTHROPIC_BASE_URL** - In `~/.claude/settings.json`:
   ```json
   { "env": { "ANTHROPIC_BASE_URL": "http://127.0.0.1:8080" } }
   ```

4. **Context truncation** - In `formatTeamMemoryContext()`, reasoning is truncated to 80 chars:
   ```typescript
   lines.push(`  Key: ${truncate(task.reasoning_trace[0], 80)}`);
   ```

---

## Test Project Location

Testing happens in: `/Users/tonyystef/testing-grov` (a cloned Dimini project)
Grov source is in: `/Users/tonyystef/qsav/Grov`

---

## Summary

**What works:**
- Capture extracts good, specific reasoning with file paths
- Tasks are saved to database with correct project_path
- Session management works

**What doesn't work:**
- Injection - Claude still explores instead of using stored context
- Need to add console.log debugging to find where the pipeline breaks

**Most likely issues:**
1. `buildTeamMemoryContext()` returning `null` (query not finding tasks)
2. Context being injected but Claude ignoring it (format not compelling enough)
3. Some path mismatch between stored project_path and current project_path
