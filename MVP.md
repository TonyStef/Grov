# Grov MVP - Implementation Guide

## What We're Building

A CLI tool with **3 commands** that makes Claude Code remember reasoning across sessions.

```
grov init      → Registers hooks (user runs once)
grov capture   → Runs automatically after each Claude response
grov inject    → Runs automatically when Claude starts a session
```

That's the entire product.

---

## How It Works (User Perspective)

```bash
# One-time setup
npm install -g grov
grov init

# Done. User forgets grov exists.
# They just use Claude Code normally:
claude "fix the auth bug"

# Behind the scenes:
# - SessionStart hook fires → grov inject → Claude sees past reasoning
# - User works normally
# - Stop hook fires → grov capture → reasoning saved for next time
```

---

## The Three Commands

### 1. `grov init`

**What it does:**
```
1. Read ~/.claude/settings.json (create if doesn't exist)
2. Add hook entries:
   {
     "hooks": {
       "Stop": ["grov capture"],
       "SessionStart": ["grov inject"]
     }
   }
3. Save file
4. Print "Done! Grov is now active."
```

**User runs this once, never again.**

---

### 2. `grov capture`

**Triggered by:** Stop hook (after every Claude response)

**What it does:**
```
1. Find the current session's JSONL file
   Location: ~/.claude/projects/<encoded-project-path>/<session-id>.jsonl

2. Parse the JSONL file:
   - Extract user messages
   - Extract assistant responses
   - Extract tool calls (Read, Write, Edit, etc.)
   - Identify files touched

3. Call Claude Haiku API with the parsed data:
   "Extract from this session:
    - Task description (what was the user trying to do?)
    - Files touched
    - Key decisions made
    - Classify status: COMPLETE | QUESTION | PARTIAL | ABANDONED"

4. Store the result in SQLite:
   Location: ~/.grov/memory.db

   INSERT INTO tasks (
     id, project_path, original_query, goal,
     reasoning_trace, files_touched, status, tags, created_at
   ) VALUES (...)
```

**Runs automatically. User never sees this.**

---

### 3. `grov inject`

**Triggered by:** SessionStart hook (when Claude starts)

**What it does:**
```
1. Get current working directory (project path)

2. Query SQLite for relevant past tasks:
   SELECT * FROM tasks
   WHERE project_path = ?
   AND status = 'complete'
   ORDER BY created_at DESC
   LIMIT 5

3. Format the results as additionalContext:
   {
     "hookSpecificOutput": {
       "additionalContext": "VERIFIED CONTEXT FROM PREVIOUS SESSIONS:\n\n[Task: fix auth bug]\n- Files: auth/session.js, middleware/token.js\n- Decision: Extended token refresh window from 5min to 15min\n- Reason: Users were getting logged out during long forms\n\nYOU MAY SKIP EXPLORE AGENTS for these files. Read them directly if needed."
     }
   }

4. Print JSON to stdout (Claude Code reads this)
```

**Runs automatically. User never sees this.**

---

## Data Flow Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                         USER WORKFLOW                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   User runs: claude "add rate limiting"                          │
│                           │                                      │
│                           ▼                                      │
│              ┌────────────────────────┐                          │
│              │    SessionStart Hook   │                          │
│              │    fires automatically │                          │
│              └───────────┬────────────┘                          │
│                          │                                       │
│                          ▼                                       │
│              ┌────────────────────────┐                          │
│              │     grov inject        │                          │
│              │  - Query SQLite        │                          │
│              │  - Output context JSON │                          │
│              └───────────┬────────────┘                          │
│                          │                                       │
│                          ▼                                       │
│              ┌────────────────────────┐                          │
│              │  Claude sees context,  │                          │
│              │  skips explore agents, │                          │
│              │  works on task         │                          │
│              └───────────┬────────────┘                          │
│                          │                                       │
│                          ▼                                       │
│              ┌────────────────────────┐                          │
│              │      Stop Hook         │                          │
│              │   fires automatically  │                          │
│              └───────────┬────────────┘                          │
│                          │                                       │
│                          ▼                                       │
│              ┌────────────────────────┐                          │
│              │     grov capture       │                          │
│              │  - Parse JSONL         │                          │
│              │  - Call Claude API     │                          │
│              │  - Store in SQLite     │                          │
│              └────────────────────────┘                          │
│                                                                  │
│   Context compounds over time. Each session makes the next       │
│   session smarter.                                               │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## File Structure

```
grov/
├── package.json              # npm package config, bin entry
├── tsconfig.json             # TypeScript config
├── src/
│   ├── cli.ts                # Entry point - parses args, routes to commands
│   │
│   ├── commands/
│   │   ├── init.ts           # grov init - register hooks
│   │   ├── capture.ts        # grov capture - extract & store reasoning
│   │   └── inject.ts         # grov inject - query & output context
│   │
│   ├── lib/
│   │   ├── jsonl-parser.ts   # Parse ~/.claude/projects/ JSONL files
│   │   ├── llm-extractor.ts  # Call Claude Haiku API for extraction
│   │   ├── store.ts          # SQLite operations (better-sqlite3)
│   │   └── hooks.ts          # Read/write ~/.claude/settings.json
│   │
│   └── types.ts              # TypeScript interfaces
│
└── dist/                     # Compiled JavaScript (git-ignored)
```

---

## Database Schema

SQLite at `~/.grov/memory.db`:

```sql
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  project_path TEXT NOT NULL,
  user TEXT,
  original_query TEXT,

  -- What Claude extracted
  goal TEXT,
  reasoning_trace JSON,        -- ["investigated X", "decided Y because Z"]
  files_touched JSON,          -- ["src/auth.ts", "src/middleware.ts"]

  -- Status (LLM-classified)
  status TEXT NOT NULL,        -- "complete" | "question" | "partial" | "abandoned"

  -- For multi-turn tasks
  parent_task_id TEXT,

  -- Auto-generated
  tags JSON,                   -- ["auth", "api"] - inferred from files/query
  created_at TEXT NOT NULL,

  FOREIGN KEY (parent_task_id) REFERENCES tasks(id)
);

-- Indexes for fast queries
CREATE INDEX idx_project ON tasks(project_path);
CREATE INDEX idx_status ON tasks(status);
CREATE INDEX idx_created ON tasks(created_at);
```

---

## Tech Stack

| Component | Choice | Why |
|-----------|--------|-----|
| Runtime | Node.js 18+ | For npm/npx distribution |
| Language | TypeScript | Type safety, better DX |
| CLI Framework | Commander.js | Simple, well-documented |
| Database | better-sqlite3 | Zero-config, fast, single file |
| LLM | Anthropic SDK (Haiku) | Cheap (~$0.001/call), fast |

---

## Build Order

| Step | Files | What You Can Test |
|------|-------|-------------------|
| 1 | `package.json`, `tsconfig.json`, `src/cli.ts` | `npx . --help` works |
| 2 | `src/commands/init.ts`, `src/lib/hooks.ts` | `grov init` registers hooks |
| 3 | `src/lib/jsonl-parser.ts` | Can parse session files |
| 4 | `src/lib/store.ts` | Can create DB, insert/query |
| 5 | `src/commands/capture.ts` | Hook fires, data stored (without LLM) |
| 6 | `src/lib/llm-extractor.ts` | Smart extraction via Claude API |
| 7 | `src/commands/inject.ts` | Full loop working |

---

## Environment Variables

```bash
# Required for LLM extraction
ANTHROPIC_API_KEY=sk-ant-...

# Optional
GROV_DB_PATH=~/.grov/memory.db      # Default
GROV_DEBUG=true                      # Verbose logging
```

---

## Example: What Gets Stored

**User session:**
```
User: "fix the auth bug where users get logged out randomly"
Claude: *reads auth/session.ts, investigates, fixes token refresh*
```

**What grov capture stores:**
```json
{
  "id": "task_abc123",
  "project_path": "/Users/dev/myapp",
  "original_query": "fix the auth bug where users get logged out randomly",
  "goal": "Prevent random user logouts",
  "reasoning_trace": [
    "Investigated token refresh logic in auth/session.ts",
    "Found refresh window was 5 minutes, too short for long forms",
    "Extended to 15 minutes with graceful refresh"
  ],
  "files_touched": ["src/auth/session.ts", "src/middleware/token.ts"],
  "status": "complete",
  "tags": ["auth", "session", "token"],
  "created_at": "2025-01-15T10:30:00Z"
}
```

**What grov inject outputs (next session):**
```json
{
  "hookSpecificOutput": {
    "additionalContext": "VERIFIED CONTEXT FROM PREVIOUS SESSIONS:\n\n[Task: fix auth logout bug]\n- Files: src/auth/session.ts, src/middleware/token.ts\n- Decision: Extended token refresh window from 5min to 15min\n- Reason: Users were getting logged out during long forms\n\nYOU MAY SKIP EXPLORE AGENTS for these files."
  }
}
```

---

## What's NOT in MVP

- Cloud sync / team features
- Web dashboard
- Semantic search / embeddings
- Complex relevance scoring
- Multiple projects management UI

These come in Phase 2+. MVP is local-only, single-user, file-path matching.

---

## Success Criteria

MVP is successful if:

1. `grov init` registers hooks without errors
2. `grov capture` runs on Stop, stores data in SQLite
3. `grov inject` runs on SessionStart, outputs valid JSON
4. Claude Code actually reads the injected context
5. Measurable reduction in explore agents on related tasks

---

## Next Steps

1. Initialize npm package
2. Build commands in order (init → capture → inject)
3. Test on real Claude Code sessions
4. Iterate based on what breaks
