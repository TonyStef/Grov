# Grov MVP - Implementation Guide

## Implementation Status: v1.0 COMPLETE

All core features implemented including hooks AND local proxy with drift detection.

### Key Milestones
- **Nov 25, 2025**: Hook-based capture/inject validated
- **Dec 2, 2025**: v1 local proxy merged with drift detection

| Component | Status | File |
|-----------|--------|------|
| CLI Entry Point | Done | `src/cli.ts` |
| Init Command | Done | `src/commands/init.ts` |
| Capture Command | Done | `src/commands/capture.ts` |
| Inject Command | Done | `src/commands/inject.ts` |
| Prompt Inject Command | Done | `src/commands/prompt-inject.ts` |
| Status Command | Done | `src/commands/status.ts` |
| Unregister Command | Done | `src/commands/unregister.ts` |
| Drift Test Command | Done | `src/commands/drift-test.ts` |
| Proxy Server | Done | `src/proxy/server.ts` |
| Proxy Status Command | Done | `src/commands/proxy-status.ts` |
| Hooks Helper | Done | `src/lib/hooks.ts` |
| JSONL Parser | Done | `src/lib/jsonl-parser.ts` |
| SQLite Store | Done | `src/lib/store.ts` |
| LLM Extractor | Done | `src/lib/llm-extractor.ts` |
| Drift Checker (Hook) | Done | `src/lib/drift-checker.ts` |
| Drift Checker (Proxy) | Done | `src/lib/drift-checker-proxy.ts` |
| Correction Builder | Done | `src/lib/correction-builder-proxy.ts` |

---

## Quick Start

### Option 1: Hooks Only (Basic)
```bash
npm install -g grov
grov init
claude
```

### Option 2: With Proxy (Full Features + Drift Detection)
```bash
npm install -g grov
grov init

# Terminal 1: Start proxy
grov proxy

# Terminal 2: Use Claude with proxy
ANTHROPIC_BASE_URL=http://127.0.0.1:8080 claude
```

### Development
```bash
cd /path/to/grov
npm install
npm run build
node dist/cli.js --help
```

---

## Commands

```
grov init           # Register hooks in Claude Code (run once)
grov capture        # Stop hook - extract & store reasoning
grov inject         # SessionStart hook - inject context
grov prompt-inject  # UserPromptSubmit hook - per-prompt context
grov status         # Show captured tasks for current project
grov status -a      # Show all tasks (including partial/abandoned)
grov unregister     # Remove hooks from Claude Code
grov drift-test     # Test drift detection (debug)
grov proxy          # Start local proxy server
grov proxy-status   # Show active proxy sessions
```

---

## Architecture Overview

### Two Modes of Operation

**1. Hook Mode (Basic)**
```
SessionStart hook → grov inject → context injected
User works with Claude
Stop hook → grov capture → reasoning saved
```

**2. Proxy Mode (Full Features)**
```
Claude Code → ANTHROPIC_BASE_URL=localhost:8080
    ↓
Local Proxy (Fastify)
    ├── Inject team memory context
    ├── Forward to Anthropic API
    ├── Parse response (extract actions)
    ├── Drift detection (every prompt)
    ├── Inject corrections if drifting
    └── Track tokens, trigger CLEAR at 180k
    ↓
Claude Code receives response
```

---

## Anti-Drift System

Monitors Claude's **actions** (not user prompts) and corrects when drifting from goal.

### Drift Scoring (1-10)
| Score | Level | Action |
|-------|-------|--------|
| 8-10 | Aligned | No correction |
| 7 | Nudge | Brief reminder (2-3 sentences) |
| 5-6 | Correct | Full correction + recovery steps |
| 3-4 | Intervene | Strong correction + mandatory first action |
| 1-2 | Halt | Critical stop + forced action |

### Session Modes
- `normal` - Working as expected
- `drifted` - Drift detected, waiting for recovery
- `forced` - After 3 failed recoveries, forces specific action

### Recovery Flow
1. Drift detected (score < 5)
2. Inject correction into next request
3. Check if Claude's next action aligns with recovery plan
4. If yes → back to normal. If no → escalate.

---

## Database Schema

SQLite at `~/.grov/memory.db`:

### tasks (Team Memory - Permanent)
```sql
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  project_path TEXT NOT NULL,
  user TEXT,
  original_query TEXT,
  goal TEXT,
  reasoning_trace JSON,      -- ["investigated X", "decided Y"]
  files_touched JSON,        -- ["src/auth.ts"]
  decisions JSON,            -- [{"choice": "X", "reason": "Y"}]
  constraints JSON,          -- ["rate limit 100/min"]
  status TEXT NOT NULL,      -- complete|question|partial|abandoned
  trigger_reason TEXT,       -- complete|threshold|abandoned
  parent_task_id TEXT,
  tags JSON,
  created_at TEXT NOT NULL
);
```

### session_states (Active Sessions - Temporary)
```sql
CREATE TABLE session_states (
  session_id TEXT PRIMARY KEY,
  user_id TEXT,
  project_path TEXT NOT NULL,
  original_goal TEXT,
  expected_scope JSON,
  constraints JSON,
  keywords JSON,
  token_count INTEGER DEFAULT 0,
  escalation_count INTEGER DEFAULT 0,
  session_mode TEXT DEFAULT 'normal',  -- normal|drifted|forced
  waiting_for_recovery BOOLEAN DEFAULT FALSE,
  parent_session_id TEXT,
  task_type TEXT DEFAULT 'main',       -- main|subtask|parallel
  start_time TEXT NOT NULL,
  last_update TEXT NOT NULL,
  status TEXT DEFAULT 'active'
);
```

### steps (Action Log - Proxy Uses)
```sql
CREATE TABLE steps (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  action_type TEXT NOT NULL,  -- edit|write|bash|read|glob|grep|task
  files JSON,
  command TEXT,
  drift_score INTEGER,
  drift_type TEXT,            -- none|minor|major|critical
  is_key_decision BOOLEAN,
  correction_given TEXT,
  timestamp INTEGER NOT NULL
);
```

### drift_log (Rejected Actions - Audit)
```sql
CREATE TABLE drift_log (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  action_type TEXT,
  files JSON,
  drift_score INTEGER,
  drift_reason TEXT,
  correction_given TEXT
);
```

### file_reasoning (Location Anchors)
```sql
CREATE TABLE file_reasoning (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  anchor TEXT,              -- function/class name
  line_start INTEGER,
  line_end INTEGER,
  change_type TEXT,         -- read|write|edit|create|delete
  reasoning TEXT,
  created_at TEXT NOT NULL
);
```

---

## File Structure

```
grov/
├── package.json
├── tsconfig.json
├── docs/
│   ├── MVP.md                    # This file
│   ├── plan_proxy_local.md       # Detailed proxy architecture
│   └── ROADMAP.md
├── src/
│   ├── cli.ts                    # Entry point
│   │
│   ├── commands/
│   │   ├── init.ts               # Register hooks
│   │   ├── capture.ts            # Stop hook - extract reasoning
│   │   ├── inject.ts             # SessionStart hook - inject context
│   │   ├── prompt-inject.ts      # UserPromptSubmit hook
│   │   ├── status.ts             # Show tasks
│   │   ├── unregister.ts         # Remove hooks
│   │   ├── drift-test.ts         # Test drift detection
│   │   └── proxy-status.ts       # Show proxy sessions
│   │
│   ├── proxy/
│   │   ├── index.ts              # CLI entry for `grov proxy`
│   │   ├── server.ts             # Fastify HTTP server
│   │   ├── config.ts             # Proxy configuration
│   │   ├── forwarder.ts          # Forward to Anthropic (undici)
│   │   ├── action-parser.ts      # Parse tool_use from response
│   │   ├── request-processor.ts  # Inject context into requests
│   │   └── response-processor.ts # Save to team memory
│   │
│   └── lib/
│       ├── store.ts              # SQLite operations
│       ├── hooks.ts              # Hook registration
│       ├── jsonl-parser.ts       # Parse session JSONL
│       ├── session-parser.ts     # Parse session data
│       ├── llm-extractor.ts      # LLM calls (OpenAI + Claude)
│       ├── drift-checker.ts      # Hook-side drift detection
│       ├── drift-checker-proxy.ts    # Proxy-side drift detection
│       ├── correction-builder.ts     # Hook-side corrections
│       ├── correction-builder-proxy.ts # Proxy-side corrections
│       └── anchor-extractor.ts   # Extract code anchors
│
└── dist/                         # Compiled JS (git-ignored)
```

---

## Tech Stack

| Component | Choice | Why |
|-----------|--------|-----|
| Runtime | Node.js 18+ | npm distribution |
| Language | TypeScript | Type safety |
| CLI | Commander.js | Simple, documented |
| Database | better-sqlite3 | Zero-config, fast |
| Proxy Server | Fastify v5.6 | Fast, hooks system |
| HTTP Client | undici v7.16 | Node.js official, fast |
| LLM (Extraction) | OpenAI GPT-3.5-turbo | Cheap reasoning extraction |
| LLM (Drift) | Claude Haiku 4.5 | Intent, drift, orchestration |
| Logging | pino v10 | Fast structured logging |

---

## Environment Variables

```bash
# Required for reasoning extraction (capture command)
OPENAI_API_KEY=sk-...

# Required for drift detection and intent extraction
ANTHROPIC_API_KEY=sk-ant-...

# Optional
GROV_DB_PATH=~/.grov/memory.db      # Default database location
GROV_DEBUG=true                      # Verbose logging

# Proxy settings (optional)
PROXY_HOST=127.0.0.1                 # Default
PROXY_PORT=8080                      # Default
```

---

## Data Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                      HOOK MODE (Basic)                          │
├─────────────────────────────────────────────────────────────────┤
│  User: claude "fix auth bug"                                    │
│           ↓                                                     │
│  SessionStart hook → grov inject → context JSON to Claude       │
│           ↓                                                     │
│  Claude works (with past context)                               │
│           ↓                                                     │
│  Stop hook → grov capture → reasoning saved to SQLite           │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                    PROXY MODE (Full)                            │
├─────────────────────────────────────────────────────────────────┤
│  User: ANTHROPIC_BASE_URL=localhost:8080 claude "fix auth bug"  │
│           ↓                                                     │
│  Every API call intercepted by local proxy                      │
│           ↓                                                     │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ REQUEST PROCESSING                                       │    │
│  │ - Check token count (CLEAR if > 180k)                   │    │
│  │ - Query team memory for relevant context                │    │
│  │ - Inject context into system prompt                     │    │
│  │ - Inject correction if session_mode == 'drifted'        │    │
│  └─────────────────────────────────────────────────────────┘    │
│           ↓                                                     │
│  Forward to Anthropic API                                       │
│           ↓                                                     │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ RESPONSE PROCESSING                                      │    │
│  │ - Parse tool_use blocks (files, commands)               │    │
│  │ - Update token_count from response.usage                │    │
│  │ - Drift check (score 1-10)                              │    │
│  │ - Save to steps table (if score >= 5)                   │    │
│  │ - Save to drift_log (if score < 5)                      │    │
│  │ - Detect task completion → save to team memory          │    │
│  └─────────────────────────────────────────────────────────┘    │
│           ↓                                                     │
│  Response returned to Claude Code (unmodified)                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## What's NOT in MVP

- Cloud sync / team features
- Web dashboard
- Semantic search / embeddings
- Multiple projects management UI

See `ROADMAP.md` for Phase 2+ plans.

---

## Success Criteria

MVP is successful if:

1. `grov init` registers hooks without errors
2. `grov capture` runs on Stop, stores data in SQLite
3. `grov inject` runs on SessionStart, outputs valid JSON
4. `grov proxy` starts and intercepts API calls
5. Drift detection identifies off-track actions
6. Corrections bring Claude back on track
7. Measurable reduction in explore agents on related tasks

---

## Detailed Architecture

For detailed proxy architecture, database schemas, and implementation details, see:
- `docs/plan_proxy_local.md` - Complete proxy implementation plan
