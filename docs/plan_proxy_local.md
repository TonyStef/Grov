# Plan: Local Proxy Implementation for Grov

## Overview

Implement local proxy layer between Claude Code and Anthropic API, enabling real-time drift detection, context management, and team memory features. Minimal changes to existing codebase, maximum reuse of current logic.

---

## FILE SUMMARY (Quick Reference)

### New Files Created

| File | Purpose |
|------|---------|
| `src/proxy/server.ts` | Main Fastify server - routes, session tracking, request/response handling |
| `src/proxy/forwarder.ts` | HTTP forwarding to Anthropic using undici - buffers response, handles errors |
| `src/proxy/config.ts` | Proxy configuration - ports, timeouts, thresholds, header whitelist |
| `src/proxy/action-parser.ts` | Parses tool_use blocks from Anthropic API response - extracts files, commands |
| `src/proxy/request-processor.ts` | Context injection from team memory - queries tasks/steps tables |
| `src/proxy/response-processor.ts` | Saves session to team memory - builds task from session+steps |
| `src/proxy/index.ts` | CLI entry point for `npm run proxy` |
| `src/lib/drift-checker.ts` | Hook-only drift detection - uses hook data sources |
| `src/lib/drift-checker-proxy.ts` | Proxy drift detection - uses steps table, separate from hook |
| `src/lib/correction-builder.ts` | Hook-only correction builder |
| `src/lib/correction-builder-proxy.ts` | Proxy correction builder - separate from hook |
| `src/commands/proxy-status.ts` | CLI command: show active proxy sessions |

### Modified Files

| File | Changes |
|------|---------|
| `src/lib/store.ts` | New tables (steps, drift_log), updated session_states schema, new CRUD, `getStepsReasoningByPath()` |
| `src/lib/llm-extractor.ts` | Added `extractIntent()`, `generateSessionSummary()`, improved reasoning_trace prompt |
| `src/commands/capture.ts` | Removed `files_explored` reference (field deleted from SessionState) |
| `src/cli.ts` | Added `grov proxy` and `grov proxy-status` commands |
| `package.json` | Added `@anthropic-ai/sdk` dependency, `proxy` script |

### Key Features Implemented

| Feature | Location | Description |
|---------|----------|-------------|
| Intent Extraction (3.1) | `llm-extractor.ts` | Extract goal, scope, constraints from first prompt via Haiku |
| Improved Prompt (3.5) | `llm-extractor.ts` | Specific examples for reasoning_trace extraction |
| Recovery Flow (4.4) | `server.ts`, `drift-checker-proxy.ts` | `checkRecoveryAlignment()` verifies action matches recovery plan |
| Forced Mode (4.4) | `drift-checker-proxy.ts` | `generateForcedRecovery()` - Haiku generates recovery prompt on escalation >= 3 |
| Team Memory Triggers (4.6) | `server.ts` | `detectTaskCompletion()` triggers save on completion phrases |
| Hook/Proxy Separation | `*-proxy.ts` files | Avoid collisions when running hook and proxy independently |
| CLI Commands | `cli.ts`, `proxy-status.ts` | `grov proxy`, `grov proxy-status` commands |
| Model | All LLM calls | Uses `claude-haiku-4-5-20251001` |

---

## PART 1: DATABASE ARCHITECTURE

### 1.1 Table Purposes and Relationships

```
session_states (1 row per active user)
    Purpose: Session configuration + current state (NOT history)
    Lifetime: Created on session start, deleted on session end
    Relationship: Parent of steps
        |
        | 1:N (one session has many steps)
        v
steps (N rows per session)
    Purpose: Action log for current session (append-only)
    Lifetime: Created during session, deleted after save to team memory
    Relationship: Child of session_states, used to generate tasks
        |
        | On session end: summarize steps -> insert task
        v
tasks (shared team memory)
    Purpose: Permanent storage of completed work summaries
    Lifetime: Permanent, shared across all team members
    Relationship: Independent, queryable by all users

drift_log (optional, for debugging)
    Purpose: Store rejected actions (score < 5) for audit
    Lifetime: Can be cleaned periodically
```

### 1.2 Multi-User Scenario

```
User A (active session)          User B (active session)
        |                                |
        v                                v
session_states: 1 row (A)        session_states: 1 row (B)
        |                                |
        v                                v
steps: N rows (session A)        steps: M rows (session B)
        |                                |
        +----------------+---------------+
                         |
                         v
              tasks (shared team memory)
              - Completed tasks from A
              - Completed tasks from B
              - Historical tasks from all users
```

### 1.3 Session States - Schema Cleanup

**Problem identified:** Current schema has duplicate columns that belong in steps table:
- `actions_taken JSON` - REDUNDANT (same data in steps)
- `files_explored JSON` - REDUNDANT (same data in steps)
- `drift_history JSON` - Should be derived from steps or kept minimal

**Corrected schema - session_states should only contain:**

```sql
CREATE TABLE session_states (
  -- Identity
  session_id TEXT PRIMARY KEY,
  user_id TEXT,
  project_path TEXT NOT NULL,

  -- Configuration (set once at session start)
  original_goal TEXT,
  expected_scope JSON DEFAULT '[]',
  constraints JSON DEFAULT '[]',
  keywords JSON DEFAULT '[]',

  -- Current state (updated during session)
  token_count INTEGER DEFAULT 0,
  escalation_count INTEGER DEFAULT 0,
  session_mode TEXT DEFAULT 'normal',      -- 'normal' | 'drifted' | 'forced'
  waiting_for_recovery BOOLEAN DEFAULT FALSE,
  last_checked_at INTEGER DEFAULT 0,
  last_clear_at INTEGER,

  -- Timestamps
  start_time TEXT NOT NULL,
  last_update TEXT NOT NULL,
  status TEXT DEFAULT 'active'             -- 'active' | 'completed' | 'abandoned'
);
```

**Columns to REMOVE from current schema:**
- `actions_taken` - use steps table instead
- `files_explored` - use steps table instead
- `drift_warnings` - derive from steps or remove
- `current_intent` - not needed with proper goal tracking

**New columns to ADD:**
- `token_count INTEGER` - from Anthropic API response.usage
- `session_mode TEXT` - for drift state machine
- `waiting_for_recovery BOOLEAN` - for recovery flow
- `last_clear_at INTEGER` - timestamp of last CLEAR operation

### 1.4 Steps Table - Schema

**Purpose:** Log every Claude action for retrieval and summary generation

```sql
CREATE TABLE steps (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,

  -- Action data
  action_type TEXT NOT NULL,    -- 'edit' | 'write' | 'bash' | 'read' | etc.
  files JSON DEFAULT '[]',
  folders JSON DEFAULT '[]',
  command TEXT,                  -- for bash actions

  -- Drift data
  drift_score INTEGER,
  drift_type TEXT,               -- 'none' | 'minor' | 'major' | 'critical'
  is_key_decision BOOLEAN DEFAULT FALSE,
  is_validated BOOLEAN DEFAULT TRUE,  -- FALSE for score < 5

  -- Correction data (if drift detected)
  correction_given TEXT,
  correction_level TEXT,         -- 'nudge' | 'correct' | 'intervene' | 'halt'

  -- Metadata
  keywords JSON DEFAULT '[]',
  timestamp INTEGER NOT NULL,

  FOREIGN KEY (session_id) REFERENCES session_states(session_id)
);

CREATE INDEX idx_steps_session ON steps(session_id);
CREATE INDEX idx_steps_timestamp ON steps(timestamp);
CREATE INDEX idx_steps_files ON steps(files);
```

### 1.5 Tasks Table (Team Memory) - Schema

**Purpose:** Permanent storage of completed session summaries, shared across team

```sql
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  project_path TEXT NOT NULL,
  user TEXT,

  -- Content
  original_query TEXT NOT NULL,
  goal TEXT,
  reasoning_trace JSON DEFAULT '[]',
  files_touched JSON DEFAULT '[]',
  decisions JSON DEFAULT '[]',      -- NEW: [{choice, reason}]
  constraints JSON DEFAULT '[]',    -- NEW: discovered limitations

  -- Status
  status TEXT NOT NULL,          -- 'complete' | 'partial' | 'abandoned'
  trigger_reason TEXT,           -- 'complete' | 'threshold' | 'abandoned'

  -- Relationships
  linked_commit TEXT,
  parent_task_id TEXT,

  -- Metadata
  tags JSON DEFAULT '[]',
  created_at TEXT NOT NULL,

  FOREIGN KEY (parent_task_id) REFERENCES tasks(id)
);
```

### 1.5.1 Team Memory Granularity Improvements

**Problem identified:** Analyzed what gets saved to team memory and found:
1. `reasoning_trace` - exists but is vague ("Investigated auth flow")
2. `decisions` - extracted by LLM but NOT saved to tasks table
3. `constraints` - extracted by LLM but NOT saved to tasks table

**Why we need these:**

| Field | Why it was missing | Value added |
|-------|-------------------|-------------|
| `decisions` | LLM extracts `{choice, reason}` but we don't save | User B sees WHY X was chosen, no repeat research |
| `constraints` | LLM extracts limitations but we don't save | User B knows what limitations to respect |
| `reasoning_trace` improved | Vague prompt -> vague output | Specific = actionable for context injection |

**Required changes:**

1. **Add columns to tasks table:**
   - `decisions JSON DEFAULT '[]'`
   - `constraints JSON DEFAULT '[]'`

2. **Update store.ts saveTask():**
   - Include decisions and constraints from ExtractedReasoning

3. **Update llm-extractor.ts prompt (see Section 3.5)**

### 1.6 Drift Log Table (Optional)

**Purpose:** Store rejected actions for debugging/audit

```sql
CREATE TABLE drift_log (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  action_type TEXT,
  files JSON,
  drift_score INTEGER,
  drift_reason TEXT,
  correction_given TEXT,
  recovery_plan JSON,
  FOREIGN KEY (session_id) REFERENCES session_states(session_id)
);
CREATE INDEX idx_drift_log_session ON drift_log(session_id);
```

### 1.7 Data Flow Summary

```
SESSION START:
  INSERT session_states (1 row with goal, scope, constraints)

DURING SESSION (per response):
  INSERT steps (action log)
  UPDATE session_states (token_count only)

DURING SESSION (every 3 prompts):
  Drift check using steps data
  UPDATE session_states (escalation_count, session_mode)

SESSION END / THRESHOLD:
  READ session_states (goal, scope)
  READ steps WHERE session_id = X
  LLM: generate summary from steps
  INSERT tasks (team memory)
  DELETE steps WHERE session_id = X
  DELETE session_states WHERE session_id = X
```

### 1.8 Hook vs Proxy Table Usage

| Table | Hook Usage | Proxy Usage |
|-------|-----------|-------------|
| `session_states` | Per Claude Code session | Per proxy session (different IDs) |
| `steps` | NOT USED | All Claude actions |
| `file_reasoning` | File-level reasoning | NOT USED |
| `tasks` | Completed tasks | Completed tasks |
| `drift_log` | NOT USED | Rejected actions (score < 5) |

**Zero conflicts:** Each system writes to its own tables. Shared tables (tasks) use different session IDs, preventing data corruption when running both systems.

---

## PART 2: SMART CONTEXT INJECTION

### 2.1 Context Injection Sources (IMPORTANT)

**Hook version** (prompt-inject.ts):

| Source | Function | Purpose |
|--------|----------|---------|
| Team Memory | `getTasksForProject()` | What others did on same project |
| File Reasoning | `getFileReasoningByPath()` | Reasoning about specific files (from file_reasoning table) |

**Proxy version** (request-processor.ts):

| Source | Function | Purpose |
|--------|----------|---------|
| Team Memory | `getTasksForProject()` | What others did on same project |
| Steps Reasoning | `getStepsReasoningByPath()` | Reasoning about specific files (from steps table) |

**Why different sources:**
- Hook populates `file_reasoning` table, proxy populates `steps` table
- Each system queries its own data source for file-level reasoning
- Team memory (tasks table) is shared by both

**What is NOT used for injection:**

| Source | Functions | Purpose |
|--------|-----------|---------|
| Steps (current session) | `getRelevantSteps()`, `getRecentSteps()` | Only for drift check, NOT for injection |

**Reason:** Steps are current session actions - Claude already knows what it did.

### 2.2 Reusable Components (No Changes)

**From src/lib/store.ts:**
- `getTasksForProject()` - query team memory by project
- `getTasksByFiles()` - query team memory by files touched
- `getFileReasoningByPath()` - query file-level reasoning
- `getFileReasoningByPathPattern()` - pattern-based file query
- `getRelevantSteps()` - 4-query retrieval for drift context (NOT for injection)
- `getRecentSteps()` - recent N steps (NOT for injection)

**From src/commands/prompt-inject.ts:**
- `extractFilePaths()` - parse file paths from prompt
- `extractKeywords()` - extract keywords with stop words
- `findKeywordMatches()` - match keywords against tasks
- `buildPromptContext()` - format context for injection
- `isSimplePrompt()` - detect simple prompts to skip

### 2.2 Injection Method Change

**Current (hook version):**
```javascript
// Output JSON, Claude Code appends to system prompt
console.log(JSON.stringify({
  hookSpecificOutput: { additionalContext: context }
}));
```

**Proxy version:**
```javascript
// Direct request modification
function injectContext(request, context) {
  request.system = request.system + '\n\n' + context;
  return request;
}
```

### 2.3 New: Summary Generation for CLEAR

**New function in src/lib/llm-extractor.ts:**

```typescript
async function generateSessionSummary(
  sessionState: SessionState,
  steps: StepRecord[]
): Promise<string> {
  // Uses Haiku 4.5 to create concise summary
  // Input: goal from session_states, actions from steps
  // Output: 2-3k token summary for injection after CLEAR
}
```

**Summary structure:**
```
PREVIOUS SESSION CONTEXT:
- Original goal: [from session_states.original_goal]
- Progress: [summarized from steps]
- Key decisions: [from steps where is_key_decision = true]
- Files modified: [aggregated from steps.files]
- Current state: [where left off]
- Next action: [recommended next step]
```

---

## PART 3: LLM CALLS (Haiku 4.5)

### 3.1 Existing Calls (Reuse)

| Function | Purpose | When Called |
|----------|---------|-------------|
| `extractIntent()` | Extract goal, scope, constraints from first prompt | First prompt only |
| `checkDriftWithLLM()` | Score current actions vs goal | Every 3 prompts |
| `extractReasoning()` | Extract task summary for team memory | On save to team memory |

### 3.2 New Call

| Function | Purpose | When Called |
|----------|---------|-------------|
| `generateSessionSummary()` | Create summary for CLEAR injection | On token threshold |

### 3.3 Local Testing Approach

**Decision:** Direct Haiku API calls (no mocks)
- Use real Anthropic API with your key
- Cost: ~$0.001/check - acceptable for development
- Real results, no mock maintenance overhead

### 3.4 Cost Estimate

- Drift check: ~$0.001/call x every 3 prompts
- Summary generation: ~$0.002/call x on CLEAR (rare)
- Intent extraction: ~$0.001/call x once per session
- Task extraction: ~$0.002/call x once per session end

**Total per session:** ~$0.01-0.02

### 3.5 Reasoning Trace Prompt Improvement

**Problem identified:** Analizand `src/lib/llm-extractor.ts` line 73, promptul actual e vag:
```javascript
"reasoning_trace": ["Key reasoning steps taken", "Decisions made and why", "What was investigated"],
```

**Rezultat actual (vag, neactionabil):**
```json
["Investigated auth flow", "Fixed the issue"]
```

**Why this is a problem:** Context injection receives vague info, User B doesn't know WHAT was investigated or HOW it was fixed.

**Improved prompt:**

**File:** `src/lib/llm-extractor.ts` (line 64-78)

```javascript
`Extract the following as JSON:
{
  "task": "Brief description (1 sentence)",
  "goal": "The underlying problem being solved",
  "reasoning_trace": [
    "Be SPECIFIC: include file names, function names, line numbers when relevant",
    "Format: '[Action] [target] to/for [purpose]'",
    "Example: 'Read auth.ts:47 to understand token refresh logic'",
    "Example: 'Fixed null check in validateToken() - was causing silent failures'",
    "NOT: 'Investigated auth' or 'Fixed bug'"
  ],
  "decisions": [{"choice": "What was decided", "reason": "Why this over alternatives"}],
  "constraints": ["Discovered limitations, rate limits, incompatibilities"],
  ...
}`
```

**Rezultat imbunatatit (specific, actionabil):**
```json
{
  "reasoning_trace": [
    "Read auth.ts to understand token refresh logic",
    "Found bug: refresh token expires before access token (line 47)",
    "Fixed by adding 5min buffer to refresh threshold"
  ],
  "decisions": [
    {"choice": "JWT over sessions", "reason": "Stateless, scales horizontally"}
  ],
  "constraints": [
    "API rate limit 100 req/min",
    "Token refresh requires network call"
  ]
}
```

**Value:** User B makes query, receives SPECIFIC context that helps, not vague info that confuses.

---

## PART 4: ANTI-DRIFT SYSTEM

### 4.1 Important Clarification

Anti-drift monitors **Claude's actions**, NOT user behavior.
- User can ask anything
- We check what Claude (AI) does in response
- Corrections are injected into Claude's context, not shown to user

### 4.2 Drift Check Flow

```
Every 3rd prompt:
  buildDriftCheckInput(session_states, steps)
  checkDrift() -> score 1-10

  Score 8-10: No action, INSERT step normally
  Score 7:    NUDGE injection, INSERT step with drift metadata
  Score 5-6:  CORRECT injection, INSERT step with drift metadata
  Score 3-4:  INTERVENE injection, SKIP step insert, INSERT drift_log only
  Score 1-2:  HALT injection, SKIP step insert, INSERT drift_log only
```

**IMPORTANT: Score < 5 = SKIP steps table entirely**
- Don't contaminate steps with invalid actions
- Save ONLY to drift_log for audit
- Resume INSERT to steps only after recovery (score returns >= 5)

### 4.3 Correction Levels

| Level | Score | Template | Action Required |
|-------|-------|----------|-----------------|
| nudge | 7 | Brief reminder (2-3 sentences) | None |
| correct | 5-6 | Full correction + recovery steps | Follow plan |
| intervene | 3-4 | Strong correction + mandatory first action | Confirm + follow |
| halt | 1-2 | Critical stop + forced action | Must execute specific action |

### 4.4 Recovery Flow (Score < 5)

```
1. UPDATE session_states SET session_mode = 'drifted'
2. UPDATE session_states SET waiting_for_recovery = TRUE
3. Inject correction (INTERVENE or HALT level)
4. On next Claude response:
   - Parse proposed action
   - Check if aligned with recovery_plan.steps[0]
   - If YES: session_mode = 'normal', resume saving
   - If NO: escalation_count++, re-inject stronger
5. After 3 failed recoveries: session_mode = 'forced', force specific action
```

### 4.5 CLEAR Operation

**Trigger:** `token_count > 180000` (90% of 200k context window)

**Flow:**
```
1. READ session_states + steps for current session
2. LLM call: generateSessionSummary()
3. Modify request: messages = [] (empty array)
4. Inject summary into system prompt
5. UPDATE session_states: last_clear_at = now, token_count = 0
6. Continue with fresh context + injected summary
```

**IMPORTANT: CLEAR does NOT save to team memory**
- Summary is injected for current session continuity only
- Team memory stays clean - only completed work goes there

### 4.6 Save to Team Memory - When and What

**Triggers for team memory save:**

| Trigger | Status | What saves |
|---------|--------|------------|
| Task complete | 'complete' | Full summary from steps |
| Subtask complete | 'complete' | Subtask summary |
| Session abandoned | 'abandoned' | Partial summary (best effort) |

**Flow:**
```
ON TASK/SUBTASK COMPLETE:
  1. Generate summary from session_states + steps
  2. INSERT tasks (status='complete', trigger_reason='complete')
  3. DELETE steps for completed subtask (optional)
  4. Keep session_states if continuing

ON SESSION ABANDONED:
  1. Generate summary from whatever we have
  2. INSERT tasks (status='abandoned', trigger_reason='abandoned')
  3. DELETE session_states + steps (cleanup)
```

**Granularity = subtask level**
**Quality = clean steps (score >= 5) + LLM summary**

---

## PART 5: PROXY SERVER

### 5.1 Technology Stack

**Decision:** Fastify + undici

**Why Fastify:**
- Built-in JSON schema validation (important for proxy safety)
- Built-in logging (pino) - structured, fast
- Plugin system for security upgrade later
- Native TypeScript support
- Hooks system for request/response interception

**Why undici:**
- Official Node.js HTTP client
- Fastest HTTP client for Node.js
- Connection pooling built-in
- Maintained by Node.js team

### 5.2 Architecture

```
Claude Code
    |
    | ANTHROPIC_BASE_URL=http://127.0.0.1:8080
    v
+------------------------------------------+
|           LOCAL PROXY (Fastify)          |
|                                          |
|  +------------------------------------+  |
|  |     onRequest HOOK                 |  |
|  |  - Log request (mask API key)      |  |
|  |  - Validate request structure      |  |
|  +------------------------------------+  |
|                  |                       |
|                  v                       |
|  +------------------------------------+  |
|  |     preHandler HOOK                |  |
|  |  - Check token count               |  |
|  |  - CLEAR if threshold              |  |
|  |  - Inject context into system      |  |
|  |  - Inject correction if drifted    |  |
|  +------------------------------------+  |
|                  |                       |
|                  v                       |
|  +------------------------------------+  |
|  |     HANDLER: forwardToAnthropic    |  |
|  |  - Build headers (forward safe)    |  |
|  |  - undici.request() to Anthropic   |  |
|  |  - Buffer full response            |  |
|  |  - Parse JSON                      |  |
|  +------------------------------------+  |
|                  |                       |
|                  v                       |
|  +------------------------------------+  |
|  |     onSend HOOK                    |  |
|  |  - Parse tool_use blocks           |  |
|  |  - Extract actions                 |  |
|  |  - Update token_count              |  |
|  |  - Save to steps (if score >= 5)   |  |
|  |  - Every 3rd: drift check          |  |
|  +------------------------------------+  |
|                  |                       |
+------------------------------------------+
                   |
                   v
             Claude Code
```

### 5.3 Bidirectional Flow Overview

```
=== FORWARD (Claude Code -> Proxy -> Anthropic) ===

Claude Code                    Proxy                         Anthropic
    |                            |                              |
    |-- POST /v1/messages ------>|                              |
    |   (original request)       |                              |
    |                            |-- onRequest: validate ------>|
    |                            |-- preHandler: inject ctx --->|
    |                            |                              |
    |                            |-- POST /v1/messages -------->|
    |                            |   (modified request)         |
    |                            |                              |


=== REVERSE (Anthropic -> Proxy -> Claude Code) ===

Claude Code                    Proxy                         Anthropic
    |                            |                              |
    |                            |<---- HTTP 200 + JSON --------|
    |                            |      (streaming chunks)      |
    |                            |                              |
    |                            |-- buffer chunks ------------>|
    |                            |-- parse JSON --------------->|
    |                            |-- onSend: process ---------->|
    |                            |   - extract token count      |
    |                            |   - parse tool_use           |
    |                            |   - drift check (every 3rd)  |
    |                            |   - save to DB               |
    |                            |                              |
    |<---- HTTP 200 + JSON ------|                              |
    |   (unmodified response)    |                              |
```

### 5.4 Forward Flow Detail (Claude Code -> Anthropic)

**Step 1: Claude Code sends request to Proxy**
```
POST http://127.0.0.1:8080/v1/messages
Headers:
  x-api-key: sk-ant-xxx
  anthropic-version: 2023-06-01
  content-type: application/json
  anthropic-beta: max-tokens-3-5-sonnet-2024-07-15
Body:
  { model, messages, system, max_tokens, ... }
```

**Step 2: Proxy receives, validates, modifies**
```
onRequest hook:
  - Log: "Received request, model: claude-3-5-sonnet, messages: 5"
  - Validate: body has required fields (model, messages)
  - Reject if malformed (400 Bad Request)

preHandler hook:
  - Read session_states.token_count from DB
  - If token_count > 180000:
      - Generate summary
      - Clear messages[]
      - Inject summary into system
  - Query team memory (tasks) for relevant context
  - Modify: request.body.system += "\n\n" + contextInjection
  - If session_mode == 'drifted':
      - Inject correction message into system
```

**Step 3: Proxy forwards to Anthropic**
```
handler:
  - Build safe headers (whitelist only)
  - undici.request('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': originalHeaders['x-api-key'],
        'anthropic-version': originalHeaders['anthropic-version'],
        'content-type': 'application/json',
        'anthropic-beta': originalHeaders['anthropic-beta']
      },
      body: JSON.stringify(modifiedRequestBody)
    })
```

### 5.5 Reverse Flow Detail (Anthropic -> Claude Code)

**Step 4: Proxy receives response from Anthropic**
```
In handler (continuation):
  - Anthropic responds with HTTP 200 (or 4xx/5xx)
  - Response body comes as stream chunks
  - Buffer ALL chunks until stream ends:
      const chunks = [];
      for await (const chunk of responseBody) {
        chunks.push(chunk);
      }
  - Concatenate and parse JSON:
      const fullResponse = JSON.parse(Buffer.concat(chunks).toString());
```

**Step 5: Proxy processes response**
```
onSend hook (before sending to Claude Code):

  1. Extract token usage:
     - input_tokens = fullResponse.usage.input_tokens
     - output_tokens = fullResponse.usage.output_tokens
     - UPDATE session_states SET token_count = input_tokens + output_tokens

  2. Parse tool_use blocks:
     - Iterate fullResponse.content[]
     - Find items where type == 'tool_use'
     - Extract: tool name, input params (file paths, commands)

  3. Extract actions:
     - If tool == 'Edit' or 'Write': extract file paths
     - If tool == 'Bash': extract command
     - Build action record: { type, files, command, timestamp }

  4. Drift check (every 3rd prompt):
     - prompt_count++
     - If prompt_count % 3 == 0:
         - Build drift input from session_states + recent steps
         - Call checkDriftWithLLM() -> score 1-10
         - If score < 5: set session_mode = 'drifted'

  5. Save to database:
     - If drift_score >= 5 (or no check this round):
         - INSERT INTO steps (action_type, files, drift_score, ...)
     - If drift_score < 5:
         - INSERT INTO drift_log (for audit)
         - SKIP steps insert (don't contaminate)
```

**Step 6: Proxy returns response to Claude Code**
```
Return to Claude Code:
  - Send UNMODIFIED response body
  - Claude Code receives exactly what Anthropic sent
  - Claude Code doesn't know it went through proxy
  - Status code preserved (200, 400, 500, etc.)

reply.status(statusCode).send(fullResponse);
```

### 5.6 Key Insight: What Gets Modified Where

| Direction | What gets MODIFIED | What stays UNCHANGED |
|-----------|-------------------|---------------------|
| Forward (to Anthropic) | `request.body.system` (inject context/correction) | Everything else |
| Reverse (to Claude Code) | Nothing | Entire response |

**Important:** Response to Claude Code is UNMODIFIED. The proxy only:
- Reads the response (for token count, actions)
- Saves to DB
- Forwards exactly as received

### 5.7 Header Handling

**Headers to FORWARD (whitelist approach):**
```typescript
const FORWARD_HEADERS = [
  'x-api-key',
  'anthropic-version',
  'content-type',
  'anthropic-beta'
];

function buildSafeHeaders(incomingHeaders: Headers): Headers {
  const safe = {};
  for (const header of FORWARD_HEADERS) {
    if (incomingHeaders[header]) {
      safe[header] = incomingHeaders[header];
    }
  }
  return safe;
}
```

**Headers to NEVER forward:**
- `host` (would be 127.0.0.1, not api.anthropic.com)
- `connection`
- `transfer-encoding`

**Headers to NEVER log:**
- `x-api-key` (mask: `sk-ant-xxx...xxx`)

### 5.8 Buffering Strategy

**Decision:** Buffer full response (not streaming)

**Implementation with undici:**
```typescript
async function forwardToAnthropic(body: RequestBody, headers: Headers) {
  const { statusCode, headers: resHeaders, body: resBody } = await request(
    'https://api.anthropic.com/v1/messages',
    {
      method: 'POST',
      headers: buildSafeHeaders(headers),
      body: JSON.stringify(body)
    }
  );

  // Buffer response
  const chunks: Buffer[] = [];
  for await (const chunk of resBody) {
    chunks.push(chunk);
  }
  const responseText = Buffer.concat(chunks).toString('utf-8');

  return {
    statusCode,
    headers: resHeaders,
    body: JSON.parse(responseText)
  };
}
```

**Latency impact:** ~50-100ms extra (acceptable for MVP)

**Future upgrade:** Stream passthrough with chunk parsing if latency becomes an issue.

### 5.9 Error Handling

**Anthropic errors (4xx, 5xx):**
```typescript
if (statusCode >= 400) {
  // Log error (without API key)
  logger.error({ statusCode, error: responseBody.error });

  // Forward error AS-IS to Claude Code
  // Claude Code knows how to handle Anthropic errors
  return reply.status(statusCode).send(responseBody);
}
```

**Proxy errors (network, timeout):**
```typescript
try {
  const response = await forwardToAnthropic(body, headers);
} catch (error) {
  if (error.code === 'ETIMEDOUT') {
    logger.error('Anthropic request timeout');
    return reply.status(504).send({ error: 'Gateway timeout' });
  }

  // Generic error - don't expose internal details
  logger.error({ error: error.message });
  return reply.status(502).send({ error: 'Bad gateway' });
}
```

### 5.10 Local Security Best Practices

**Even for local, we apply:**

| Practice | Implementation | Why |
|----------|---------------|-----|
| Bind 127.0.0.1 ONLY | `fastify.listen({ port: 8080, host: '127.0.0.1' })` | No external access possible |
| Never log API key | `key.substring(0,10) + '...'` | Good habit, prevents accidental leaks |
| Whitelist headers | Forward only what's needed | Prevents header injection |
| Validate input | JSON schema on request body | Prevents malformed requests |
| Timeout | `bodyTimeout: 300000` (5 min) | Prevents hanging requests |
| Request size limit | `bodyLimit: 10485760` (10MB) | Prevents memory exhaustion |

### 5.11 New Files Structure

```
src/proxy/
├── server.ts              # Fastify instance + routes + hooks
├── forwarder.ts           # undici logic for forwarding to Anthropic
├── request-processor.ts   # preHandler: context injection, CLEAR
├── response-processor.ts  # onSend: parse actions, drift check, save
├── action-parser.ts       # Parse tool_use from API response
├── config.ts              # Configuration (port, timeouts, thresholds)
└── plugins/               # Fastify plugins (for cloud upgrade)
    ├── auth.ts            # Placeholder - token validation
    ├── rate-limit.ts      # Placeholder - rate limiting
    └── tls.ts             # Placeholder - TLS termination
```

### 5.12 Configuration

```typescript
// src/proxy/config.ts
export const config = {
  // Server
  HOST: '127.0.0.1',
  PORT: 8080,

  // Anthropic
  ANTHROPIC_BASE_URL: 'https://api.anthropic.com',

  // Timeouts
  REQUEST_TIMEOUT: 300000,  // 5 minutes (Claude can be slow)
  BODY_LIMIT: 10485760,     // 10MB

  // Drift
  DRIFT_CHECK_INTERVAL: 3,
  TOKEN_CLEAR_THRESHOLD: 180000,

  // Security (Phase 2 - disabled for local)
  ENABLE_AUTH: false,
  ENABLE_RATE_LIMIT: false,
  ENABLE_TLS: false
};
```

### 5.13 Cloud Upgrade Path

**When moving to cloud, add:**

1. **TLS:**
```typescript
import { readFileSync } from 'fs';

const fastify = Fastify({
  https: {
    key: readFileSync('./certs/server.key'),
    cert: readFileSync('./certs/server.crt')
  }
});
```

2. **Auth (plugin):**
```typescript
fastify.register(import('./plugins/auth'));
// In auth.ts:
fastify.addHook('onRequest', async (request, reply) => {
  const token = request.headers['x-grov-token'];
  if (!validateToken(token)) {
    return reply.status(401).send({ error: 'Unauthorized' });
  }
});
```

3. **Rate Limit (plugin oficial):**
```typescript
fastify.register(import('@fastify/rate-limit'), {
  max: 100,
  timeWindow: '1 minute'
});
```

4. **Change bind:**
```typescript
// Local: host: '127.0.0.1'
// Cloud: host: '0.0.0.0' (with firewall rules)
```

---

## PART 6: IMPLEMENTATION ORDER

### Phase 1: Schema and Store

1. Remove duplicate columns from session_states (actions_taken, files_explored, etc.)
2. Add new columns to session_states (token_count, session_mode, etc.)
3. Add new columns to steps (is_validated, drift_type, correction_level, etc.)
4. Create drift_log table
5. Add to tasks table: trigger_reason, decisions, constraints
6. Update store.ts saveTask() to include decisions + constraints
7. Add new store functions
8. Run migrations

### Phase 2: Action Parser

1. Create action-parser.ts - parse tool_use from API response
2. Replaces JSONL parsing logic
3. Same ClaudeAction interface output

### Phase 3: Proxy Core

1. Create Fastify server
2. Request interceptor (inject context)
3. Forward to Anthropic using undici
4. Response interceptor (parse actions)
5. Test basic flow works

### Phase 4: Drift Integration

1. Wire drift checker to response handler
2. Implement every-3-prompts logic
3. Wire correction injection to request handler
4. Implement recovery flow
5. Test drift scenarios

### Phase 5: CLEAR Logic

1. Implement token counting from response.usage
2. Implement generateSessionSummary()
3. Implement CLEAR operation (modify messages[])
4. Test threshold trigger

### Phase 6: Team Memory Integration

1. Wire save-to-team-memory on complete/threshold/abandon
2. Implement trigger_reason tracking
3. Implement session cleanup (delete session_states + steps)
4. Test full flow

---

## PART 7: HOOK VS PROXY SEPARATION

### 7.1 Why Separate Files

To avoid collisions when using hook and proxy independently:
- Hook = Claude Code hooks (SessionStart, Stop, UserPromptSubmit)
- Proxy = Local proxy intercepting API calls
- User may run EITHER or BOTH simultaneously

### 7.2 Separated Files

| Hook Version | Proxy Version | Difference |
|--------------|---------------|------------|
| `drift-checker.ts` | `drift-checker-proxy.ts` | Different step sources, different injection |
| `correction-builder.ts` | `correction-builder-proxy.ts` | Different formatting for injection |

### 7.3 SessionState Composition Pattern

```typescript
// Base fields (shared by both systems)
interface SessionStateBase {
  session_id: string;
  project_path: string;
  original_goal: string;
  status: string;
  start_time: string;
  last_update: string;
}

// Proxy-specific fields
interface ProxyFields {
  token_count: number;
  escalation_count: number;
  session_mode: 'normal' | 'drifted' | 'forced';
  waiting_for_recovery: boolean;
  last_checked_at: number;
  last_clear_at: number;
}

// Full type combines both
type SessionState = SessionStateBase & ProxyFields;
```

### 7.4 Data Storage Separation

| Data Type | Hook Storage | Proxy Storage |
|-----------|--------------|---------------|
| File reasoning | `file_reasoning` table | `steps.reasoning` column |
| Actions | Not tracked | `steps` table |
| Drift events | Not tracked | `drift_log` table |
| Completed tasks | `tasks` table | `tasks` table |

### 7.5 Team Memory Query Functions

```typescript
// Hook uses (queries file_reasoning table):
getFileReasoningByPath(filePath)

// Proxy uses (queries steps table):
getStepsReasoningByPath(filePath)
```

### 7.6 Zero Conflict Guarantee

- Hook writes to: `file_reasoning`, `tasks`
- Proxy writes to: `steps`, `drift_log`, `tasks`
- Shared table (`tasks`): Different session_ids, no collision
- Can run simultaneously without data corruption

---

## PART 8: CLI COMMANDS

### 8.1 Hook Commands

| Command | Description |
|---------|-------------|
| `grov init` | Register hooks in Claude Code settings |
| `grov capture` | Capture reasoning from session (Stop hook) |
| `grov inject` | Inject context for new session (SessionStart hook) |
| `grov prompt-inject` | Per-prompt context injection (UserPromptSubmit hook) |
| `grov status` | Show stored reasoning for current project |
| `grov unregister` | Remove hooks from Claude Code |

### 8.2 Proxy Commands

| Command | Description |
|---------|-------------|
| `grov proxy` | Start proxy server on 127.0.0.1:8080 |
| `grov proxy-status` | Show active proxy sessions |

### 8.3 Usage

```bash
# Start proxy server
grov proxy

# In another terminal, use Claude Code with proxy:
ANTHROPIC_BASE_URL=http://127.0.0.1:8080 claude

# Check active sessions
grov proxy-status
```

---

## CRITICAL FILES TO MODIFY

| File | Changes |
|------|---------|
| src/lib/store.ts | New tables, updated schema, `getStepsReasoningByPath()`, session management |
| src/lib/llm-extractor.ts | `extractIntent()`, `generateSessionSummary()`, `analyzeTaskContext()` |
| src/cli.ts | Added `grov proxy` and `grov proxy-status` commands |

## NEW FILES CREATED

| File | Purpose |
|------|---------|
| src/proxy/server.ts | Fastify server - routes, session tracking, request/response handling |
| src/proxy/forwarder.ts | HTTP forwarding to Anthropic using undici |
| src/proxy/request-processor.ts | Context injection from team memory |
| src/proxy/response-processor.ts | Saves session to team memory |
| src/proxy/action-parser.ts | Parse tool_use blocks from API response |
| src/proxy/config.ts | Proxy configuration - ports, timeouts, thresholds |
| src/proxy/index.ts | CLI entry point |
| src/lib/drift-checker-proxy.ts | Proxy-specific drift detection |
| src/lib/correction-builder-proxy.ts | Proxy-specific correction builder |
| src/commands/proxy-status.ts | Show active proxy sessions |

---

## CONFIG (.env additions)

```
# Proxy settings
PROXY_HOST=127.0.0.1
PROXY_PORT=8080
ANTHROPIC_TARGET=https://api.anthropic.com

# Drift settings
DRIFT_CHECK_INTERVAL=3              # Every N prompts
TOKEN_WARNING_THRESHOLD=160000      # 80%
TOKEN_CLEAR_THRESHOLD=180000        # 90%

# Security (Phase 2)
ENABLE_AUTH=false
ENABLE_RATE_LIMIT=false
ENABLE_TLS=false
```

---

## TESTING CHECKLIST

- [ ] Proxy starts on 127.0.0.1:8080
- [ ] Claude Code connects with ANTHROPIC_BASE_URL
- [ ] Requests forward to Anthropic correctly
- [ ] Responses return to Claude Code
- [ ] Actions parsed from response (not JSONL)
- [ ] Steps saved to DB correctly
- [ ] Session states updated correctly
- [ ] Drift check runs every 3 prompts
- [ ] Corrections injected when drift detected
- [ ] Recovery flow works
- [ ] Token count tracked from response.usage
- [ ] CLEAR triggers at threshold
- [ ] Summary generated and injected after CLEAR
- [ ] Team memory saves on complete/threshold
- [ ] Session cleanup works (delete session_states + steps)

---

## RESOLVED ISSUES

### Connection and Headers

| Issue | Fix |
|-------|-----|
| Connect timeout (IPv6 fallback) | Custom Agent with 30s timeout, `autoSelectFamily: true` |
| Authorization header missing | Added `authorization` to forward headers whitelist |
| Fastify invalid payload | JSON.stringify before send, explicit content-type |

### System Prompt Format

| Issue | Fix |
|-------|-----|
| `body.system` as array | Added `appendToSystemPrompt()` and `getSystemPromptText()` helpers |

### Database

| Issue | Fix |
|-------|-----|
| Missing steps columns | ALTER TABLE migrations for drift_type, is_validated, etc. |
| Missing dotenv loading | Added dotenv config() in proxy/index.ts |

### Model and Messages

| Issue | Fix |
|-------|-----|
| Wrong Haiku model ID | Updated to `claude-haiku-4-5-20251001` |
| Goal from wrong message | Now uses LAST user message, not first |
| `<system-reminder>` in goal | Tags stripped from user messages |
| 11 Haiku calls per prompt | Now only on `stop_reason=end_turn` |

### Task Detection

| Issue | Fix |
|-------|-----|
| Session deleted too early | Mark completed instead of delete, keep 1h for comparison |
| `action=continue` always | Improved prompt, compare with completed session |

### Drift Detection

| Issue | Fix |
|-------|-----|
| False positives | Compare vs current instruction, not just original goal |
| Haiku responds in Romanian | Added "English only, no emojis" to all prompts |

### Extraction

| Issue | Fix |
|-------|-----|
| Constraints empty | Improved extractIntent prompt with explicit examples |
| Reasoning trace vague | New `extractReasoningAndDecisions()` at task_complete |

### Logging

| Change | Reason |
|--------|--------|
| Removed all file logging | Open source release - no debug logs in production |

---

## PART 9: TASK ORCHESTRATION

### 9.1 Problem Identified

**Bug:** Proxy creates new row in `session_states` for each API request:
- 1 user prompt -> 70+ requests (main model + Haiku subagents) -> 70 fake sessions
- No way to know if same task, new task, subtask, or task complete

**Solution:**
1. Skip Haiku subagents (track only main model)
2. Single Haiku call from Grov per user prompt for task orchestration

### 9.2 Schema Changes - session_states

**File:** `src/lib/store.ts`

```sql
ALTER TABLE session_states ADD COLUMN parent_session_id TEXT;
ALTER TABLE session_states ADD COLUMN task_type TEXT DEFAULT 'main';
-- task_type: 'main' | 'subtask' | 'parallel'
```

**Session states = 1 row per TASK:**
```
+-------------+---------+-----------------+----------+------------------+
| session_id  | user_id | original_goal   | task_type| parent_session_id|
+-------------+---------+-----------------+----------+------------------+
| task_001    | dev_A   | "Add dark mode" | main     | NULL             |
| task_002    | dev_A   | "Create toggle" | subtask  | task_001         |
| task_003    | dev_A   | "Fix CSS bug"   | parallel | task_001         |
| task_004    | dev_B   | "Refactor API"  | main     | NULL             |
+-------------+---------+-----------------+----------+------------------+
```

### 9.3 Steps Table - No Changes

Steps table remains the same:
- `session_id` = task_id (FK to session_states)
- Each step belongs to a specific task

### 9.4 Skip Haiku Subagents

**File:** `src/proxy/server.ts`

```typescript
async function handleMessages(request, reply) {
  const model = request.body.model;

  // Skip Haiku subagents - forward directly without tracking
  if (model.includes('haiku')) {
    const result = await forwardToAnthropic(request.body, headers, logger);
    return reply
      .status(result.statusCode)
      .header('content-type', 'application/json')
      .send(JSON.stringify(result.body));
  }
  // Rest of code - only for main model
}
```

**Rationale:**
- Haiku subagents = Task tool spawns for exploration
- They don't make decisions, only gather info
- Main model (Opus/Sonnet) has all the reasoning

### 9.5 Task Orchestration - analyzeTaskContext()

**File:** `src/lib/llm-extractor.ts`

```typescript
interface TaskAnalysis {
  action: 'continue' | 'new_task' | 'subtask' | 'parallel_task' | 'task_complete' | 'subtask_complete';
  task_id: string;
  current_goal: string;
  parent_task_id?: string;
  reasoning: string;
}

export async function analyzeTaskContext(
  currentSession: SessionState | null,
  latestUserMessage: string,
  recentSteps: StepRecord[],
  assistantResponse: string
): Promise<TaskAnalysis>
```

**Action types:**

| Action | Meaning | DB Action |
|--------|---------|-----------|
| `continue` | Same task, follow-up | Reuse session |
| `new_task` | Different work started | Create new session |
| `subtask` | Prerequisite work needed | Create linked session |
| `parallel_task` | Side task, doesn't block main | Create parallel session |
| `task_complete` | Main task finished | Save to team_memory, delete session+steps |
| `subtask_complete` | Subtask done, return to parent | Save to team_memory, delete, switch to parent |

### 9.6 Integration Flow

```
User prompt -> Main model responds -> Skip if Haiku
                    |
                    v
         analyzeTaskContext() <- Grov Haiku call
                    |
                    v
         switch(action):
           'continue'        -> reuse session
           'new_task'        -> createSessionState(type='main')
           'subtask'         -> createSessionState(type='subtask', parent=current)
           'parallel_task'   -> createSessionState(type='parallel', parent=current)
           'task_complete'   -> saveToTeamMemory() + cleanupSession()
           'subtask_complete'-> saveToTeamMemory() + cleanupSession() + switch to parent
                    |
                    v
         Save steps to correct session_id
```

### 9.7 Store Functions - Additions

```typescript
// New interfaces
interface CreateSessionStateInput {
  parent_session_id?: string;
  task_type?: 'main' | 'subtask' | 'parallel';
}

// New functions
export function getChildSessions(parentSessionId: string): SessionState[]
export function getActiveSessionForUser(projectPath: string, userId?: string): SessionState | null
```

### 9.8 Cleanup on Complete

**After `task_complete` or `subtask_complete`:**
1. `saveToTeamMemory(sessionId, 'complete')` - save to tasks table
2. `deleteStepsForSession(sessionId)` - delete steps
3. `deleteSessionState(sessionId)` - delete session

**Team memory is permanent, session+steps are temporary.**

### 9.9 Cost and Performance

| Metric | Value |
|--------|-------|
| Cost per call | ~$0.0001 (Haiku) |
| Latency | +300-500ms (async) |
| Calls per session | 1 per main model response |
| Daily cost (100 prompts) | ~$0.01 |

### 9.10 Fallback Behavior

```typescript
try {
  taskAnalysis = await analyzeTaskContext(...);
} catch (error) {
  // Fallback: continue or new_task
  taskAnalysis = {
    action: currentSession ? 'continue' : 'new_task',
    task_id: currentSession?.session_id || 'NEW',
    current_goal: latestUserMessage.substring(0, 200),
  };
}
```

### 9.11 Testing Scenarios

| Scenario | Expected action |
|----------|-----------------|
| First prompt | `new_task` |
| Follow-up question | `continue` |
| "Now fix the login bug" | `new_task` |
| "First I need to install deps" | `subtask` |
| "Also update the tests" | `parallel_task` |
| Claude says "Task complete" | `task_complete` |
| Subtask finished | `subtask_complete` |
| User does /clear | `new_task` (messages[] empty) |

### 9.12 Implementation Steps

1. **Schema**: Add `parent_session_id`, `task_type` columns + migrations
2. **Skip Haiku**: Model check in `handleMessages()`
3. **analyzeTaskContext()**: Function + prompt in llm-extractor.ts
4. **Integration**: Wire into postProcessResponse()
5. **Testing**: All scenarios from 9.11
