# Cursor CLI Integration with Grov MCP Server

> **Research Date:** January 5, 2026
> **Status:** Research Complete - Implementation Needed
> **Priority:** High - Expands Grov to CLI users

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Cursor CLI Overview](#cursor-cli-overview)
3. [Current Grov MCP Architecture](#current-grov-mcp-architecture)
4. [CLI Compatibility Analysis](#cli-compatibility-analysis)
5. [Conversation Data Storage](#conversation-data-storage)
6. [Hooks System](#hooks-system)
7. [Rules System](#rules-system)
8. [Implementation Plan](#implementation-plan)
9. [Code Examples](#code-examples)
10. [File Locations Reference](#file-locations-reference)

---

## Executive Summary

**Key Finding:** Cursor CLI is fully compatible with Grov MCP server for both READ (preview/expand) and WRITE (memory extraction) operations.

| Capability | Cursor IDE | Cursor CLI | Notes |
|------------|-----------|------------|-------|
| MCP Tools (preview/expand) | ✅ | ✅ | Same `~/.cursor/mcp.json` config |
| Conversation Capture | ✅ SQLite + stop hooks | ✅ Hooks system | Different mechanism, same result |
| Rules Injection | ✅ `.cursor/rules/` | ✅ `~/.cursor/rules/` | CLI reads global rules |
| Memory Extraction | ✅ Server-side | ✅ Hooks-based | Cleaner JSON input vs SQLite parsing |

**Bottom Line:** CLI capture is actually SIMPLER than IDE capture because hooks provide clean JSON instead of requiring SQLite parsing.

---

## Cursor CLI Overview

### Installation

```bash
curl https://cursor.com/install -fsS | bash
```

Installs to:
- Binary: `~/.local/bin/cursor-agent` (symlink)
- Actual location: `~/.local/share/cursor-agent/versions/{version}/cursor-agent`

### CLI Commands

```bash
cursor-agent --help

# Key commands:
cursor-agent                    # Start interactive agent
cursor-agent mcp list           # List configured MCP servers
cursor-agent mcp list-tools grov # List tools for specific MCP
cursor-agent --print "prompt"   # Non-interactive mode (for scripts)
cursor-agent --model sonnet-4   # Specify model
cursor-agent --workspace /path  # Set workspace directory
```

### MCP Integration Verification

```bash
# Check if grov MCP is recognized
cursor-agent mcp list
# Output: grov: ready

# List available tools
cursor-agent mcp list-tools grov
# Output:
# Tools for grov (2):
# - grov_expand (id)
# - grov_preview (context, mode)
```

---

## Current Grov MCP Architecture

### For Cursor IDE (Existing)

```
src/integrations/mcp/
├── index.ts              # Entry point - StdioServerTransport
├── server.ts             # Tool registration (preview, expand)
├── logger.ts             # File logging (mcp-cursor.log)
├── cache.ts              # In-memory preview cache (10min TTL)
├── tools/
│   ├── preview.ts        # grov_preview implementation
│   └── expand.ts         # grov_expand implementation
├── capture/
│   ├── hook-handler.ts   # IDE stop hook handler
│   ├── sqlite-reader.ts  # Reads IDE's state.vscdb
│   └── sync-tracker.ts   # Deduplication tracking
└── clients/
    └── cursor/
        └── rules-installer.ts  # Creates .cursor/rules/ files
```

### IDE Capture Flow

```
IDE Stop Hook triggers → hook-handler.ts
    ↓
Reads ~/.config/Cursor/User/globalStorage/state.vscdb
    ↓
Extracts conversation from composerData JSON
    ↓
Posts to API: POST /teams/{teamId}/cursor/extract
```

---

## CLI Compatibility Analysis

### What Works Immediately

1. **MCP Server Connection**
   - CLI reads `~/.cursor/mcp.json` (same as IDE)
   - Spawns `grov mcp` command via stdio
   - Tools appear and function correctly

2. **grov_preview Tool**
   - Fetches memories from cloud API
   - No IDE-specific dependencies
   - Works identically to IDE

3. **grov_expand Tool**
   - Retrieves from in-memory cache
   - Returns full memory details
   - Works identically to IDE

### What Needs Implementation

1. **Conversation Capture**
   - IDE: SQLite database parsing
   - CLI: Hooks system (different approach, same goal)

2. **Rules Delivery**
   - IDE: Project-level `.cursor/rules/90_grov.mdc` with `@` pointer
   - CLI: Global `~/.cursor/rules/grov.mdc` (already works!)

---

## Conversation Data Storage

### CLI SQLite Structure

CLI stores conversations in SQLite databases:

```
~/.cursor/chats/
└── {workspace_hash}/
    └── {chat_id}/
        └── store.db
```

Example path:
```
~/.cursor/chats/cf4395c49298ba23d26c91b3e1f5e51e/ad5c20f2-6b23-44fc-923f-132a264fd766/store.db
```

### Database Schema

```sql
-- Two tables only
CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
```

### Meta Table Content

Key `0` contains hex-encoded JSON:

```json
{
  "agentId": "ad5c20f2-6b23-44fc-923f-132a264fd766",
  "latestRootBlobId": "7870eea2c2e2023b01baa65a8f039ff5ac5ad7674635ee91f00e5a8935bb74b7",
  "name": "New Agent",
  "mode": "default",
  "createdAt": 1767611478642,
  "lastUsedModel": "composer-1"
}
```

### Blob Data Format

Blobs contain **protobuf-encoded** conversation data. Extractable via `strings`:

```bash
sqlite3 store.db "SELECT data FROM blobs" | strings | head -100
```

Contains:
- User prompts: `"can you use the grov mcp server ?"`
- System prompts (full)
- Tool calls with arguments
- Tool results with full JSON
- Assistant responses with thinking

**Important:** While SQLite capture is possible, the **hooks system** is the recommended approach for CLI (cleaner, no parsing needed).

---

## Hooks System

### Overview

Cursor CLI supports a hooks system via `hooks.json`. This is the **recommended approach** for CLI conversation capture.

**Documentation:** https://cursor.com/docs/agent/hooks

### Configuration Locations (Priority Order)

1. Enterprise-managed (system directories)
2. Project-level: `<project-root>/.cursor/hooks.json`
3. User global: `~/.cursor/hooks.json`

### Available Hooks

| Hook | Trigger | Use Case |
|------|---------|----------|
| `beforeSubmitPrompt` | After user sends, before API call | Capture user prompt |
| `afterAgentResponse` | After assistant message complete | Capture assistant response |
| `afterAgentThought` | After thinking block | Observe reasoning |
| `beforeShellExecution` | Before bash command | Audit/block commands |
| `afterShellExecution` | After bash command | Log command results |
| `beforeMCPExecution` | Before MCP tool call | Audit/block tool usage |
| `afterMCPExecution` | After MCP tool call | Log tool results |
| `beforeReadFile` | Before file read | Audit file access |
| `afterFileEdit` | After file modification | Audit changes |
| `stop` | Agent stopped | Cleanup |

### Key Hooks for Grov

#### beforeSubmitPrompt

Captures user's prompt BEFORE it's sent to the model.

**Input JSON:**

```json
{
  "conversation_id": "string",
  "generation_id": "string",
  "model": "string",
  "hook_event_name": "beforeSubmitPrompt",
  "cursor_version": "string",
  "workspace_roots": ["/path/to/project"],
  "user_email": "string | null",
  "prompt": "<user's actual prompt text>",
  "attachments": [
    {
      "type": "file" | "rule",
      "filePath": "/absolute/path"
    }
  ]
}
```

**Output JSON:**

```json
{
  "continue": true,
  "user_message": "Optional message if blocked"
}
```

#### afterAgentResponse

Captures assistant's response AFTER generation complete.

**Input JSON:**

```json
{
  "text": "<assistant's complete response>",
  "conversation_id": "string",
  "generation_id": "string",
  "model": "string",
  "hook_event_name": "afterAgentResponse",
  "cursor_version": "string",
  "workspace_roots": ["/path/to/project"],
  "user_email": "string | null"
}
```

**Output JSON:**

```json
{
  "continue": true
}
```

### Correlation Strategy

Both hooks share `conversation_id` and `generation_id`:

```
beforeSubmitPrompt (generation_id: "abc123")
    → Store prompt temporarily

afterAgentResponse (generation_id: "abc123")
    → Retrieve stored prompt
    → Pair with response
    → Send to extraction API
```

---

## Rules System

### How CLI Reads Rules

CLI reads rules from `~/.cursor/rules/` directory (global).

**Verified:** In test conversation, the model said:
> "Looking at the rules, I can see that there are Grov-related tools mentioned: grov_preview, grov_expand, grov_save..."

### Current Global Rules File

Location: `~/.cursor/rules/grov.mdc`

```markdown
---
alwaysApply: true
---

# Grov Team Memory

You have access to Grov, a team memory system. This is the source of truth
for what the team has built, why decisions were made, and how systems work.

## Tools

grov_preview - fetches relevant memories. Call at START of every conversation.
grov_expand - gets full details for memories by index from preview.
grov_save - records your work after completing the request.
grov_decide_update - called only when grov_save returns needs_decision: true.

## Order of Operations

1. Call grov_preview FIRST, before any other action
   - context: user's question
   - mode: "agent" | "planning" | "ask" based on your current mode

2. If relevant memories found, call grov_expand with indices

3. Do your work using memory content as guidance

4. Call grov_save when complete:
   - goal: what was accomplished (max 150 chars)
   - original_query: user's request
   - summary: brief description for search (max 200 chars)
   - reasoning_trace: array of {conclusion, insight} (max 5)
   - decisions: array of {choice, reason} (max 5)
   - files_touched: file paths
   - mode: your current mode

5. If grov_save returns needs_decision: true, call grov_decide_update:
   - decision: "update" if new knowledge added, "skip" if nothing new
   - reason: brief explanation
```

### IDE vs CLI Rules

| Aspect | Cursor IDE | Cursor CLI |
|--------|-----------|------------|
| Project rules | `.cursor/rules/90_grov.mdc` | Not supported (use global) |
| `@` include syntax | ✅ Works | ❌ Not supported |
| Global rules | `~/.cursor/rules/` | ✅ Works |
| `alwaysApply: true` | ✅ | ✅ |

**Recommendation:** For CLI, put complete rules in `~/.cursor/rules/grov.mdc`. The `@` pointer mechanism is IDE-specific.

---

## Implementation Plan

### Phase 1: Hook Handler Commands

Create new CLI commands for hook handling:

```bash
grov hook prompt    # Handle beforeSubmitPrompt
grov hook response  # Handle afterAgentResponse
```

### Phase 2: Hooks Configuration Setup

Add to `grov init cursor` flow:

1. Create/update `~/.cursor/hooks.json`
2. Register grov hook handlers

### Phase 3: Conversation Pairing

Implement temporary storage to correlate prompt + response:

1. `beforeSubmitPrompt` → Store in `~/.grov/cli_pending.json`
2. `afterAgentResponse` → Read pending, pair, send to API, cleanup

### Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                        Cursor CLI                                │
│                                                                  │
│  User types prompt → beforeSubmitPrompt hook fires              │
│         │                                                        │
│         ▼                                                        │
│  ┌──────────────────┐                                           │
│  │ grov hook prompt │ ──► Stores {conversation_id, prompt}      │
│  └──────────────────┘     in ~/.grov/cli_pending.json           │
│         │                                                        │
│         ▼                                                        │
│  Model generates response                                        │
│         │                                                        │
│         ▼                                                        │
│  afterAgentResponse hook fires                                   │
│         │                                                        │
│         ▼                                                        │
│  ┌────────────────────┐                                         │
│  │ grov hook response │ ──► Reads pending prompt                │
│  └────────────────────┘     Pairs with response                 │
│         │                   Sends to extraction API              │
│         ▼                   Cleans up pending                    │
│  ┌──────────────────────────────────────┐                       │
│  │ POST /teams/{id}/cursor/extract      │                       │
│  │ {                                    │                       │
│  │   userPrompt: "...",                 │                       │
│  │   assistantResponse: "...",          │                       │
│  │   conversationId: "...",             │                       │
│  │   generationId: "...",               │                       │
│  │   model: "...",                      │                       │
│  │   projectPath: "...",                │                       │
│  │   source: "cursor-cli"               │                       │
│  │ }                                    │                       │
│  └──────────────────────────────────────┘                       │
└─────────────────────────────────────────────────────────────────┘
```

---

## Code Examples

### hooks.json Configuration

```json
{
  "version": 1,
  "hooks": {
    "beforeSubmitPrompt": [
      {
        "command": "grov hook prompt"
      }
    ],
    "afterAgentResponse": [
      {
        "command": "grov hook response"
      }
    ]
  }
}
```

### Hook Handler Skeleton (TypeScript)

```typescript
// src/cli/commands/hook.ts

import { Command } from 'commander';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const PENDING_FILE = join(homedir(), '.grov', 'cli_pending.json');

interface PromptHookInput {
  conversation_id: string;
  generation_id: string;
  model: string;
  hook_event_name: string;
  cursor_version: string;
  workspace_roots: string[];
  user_email: string | null;
  prompt: string;
  attachments: Array<{ type: string; filePath: string }>;
}

interface ResponseHookInput {
  text: string;
  conversation_id: string;
  generation_id: string;
  model: string;
  hook_event_name: string;
  cursor_version: string;
  workspace_roots: string[];
  user_email: string | null;
}

interface PendingEntry {
  conversation_id: string;
  generation_id: string;
  prompt: string;
  model: string;
  workspace: string;
  timestamp: number;
}

export function registerHookCommand(program: Command) {
  const hook = program
    .command('hook')
    .description('Handle Cursor CLI hooks');

  hook
    .command('prompt')
    .description('Handle beforeSubmitPrompt hook')
    .action(async () => {
      // Read JSON from stdin
      const input = readStdin();
      const data: PromptHookInput = JSON.parse(input);

      // Store pending prompt
      const pending: PendingEntry = {
        conversation_id: data.conversation_id,
        generation_id: data.generation_id,
        prompt: data.prompt,
        model: data.model,
        workspace: data.workspace_roots[0] || '',
        timestamp: Date.now()
      };

      // Load existing pending entries
      let entries: Record<string, PendingEntry> = {};
      if (existsSync(PENDING_FILE)) {
        entries = JSON.parse(readFileSync(PENDING_FILE, 'utf-8'));
      }

      // Add new entry keyed by generation_id
      entries[data.generation_id] = pending;

      // Cleanup old entries (> 1 hour)
      const oneHourAgo = Date.now() - 3600000;
      for (const [key, entry] of Object.entries(entries)) {
        if (entry.timestamp < oneHourAgo) {
          delete entries[key];
        }
      }

      // Save
      writeFileSync(PENDING_FILE, JSON.stringify(entries, null, 2));

      // Output: allow prompt to continue
      console.log(JSON.stringify({ continue: true }));
    });

  hook
    .command('response')
    .description('Handle afterAgentResponse hook')
    .action(async () => {
      // Read JSON from stdin
      const input = readStdin();
      const data: ResponseHookInput = JSON.parse(input);

      // Load pending entries
      if (!existsSync(PENDING_FILE)) {
        console.log(JSON.stringify({ continue: true }));
        return;
      }

      const entries: Record<string, PendingEntry> = JSON.parse(
        readFileSync(PENDING_FILE, 'utf-8')
      );

      // Find matching prompt by generation_id
      const pending = entries[data.generation_id];

      if (pending) {
        // Send to extraction API
        await sendToExtractionAPI({
          userPrompt: pending.prompt,
          assistantResponse: data.text,
          conversationId: data.conversation_id,
          generationId: data.generation_id,
          model: pending.model,
          projectPath: pending.workspace,
          source: 'cursor-cli'
        });

        // Remove from pending
        delete entries[data.generation_id];
        writeFileSync(PENDING_FILE, JSON.stringify(entries, null, 2));
      }

      // Output: allow response to complete
      console.log(JSON.stringify({ continue: true }));
    });
}

function readStdin(): string {
  // Synchronously read all of stdin
  const chunks: Buffer[] = [];
  const fd = 0; // stdin
  const buf = Buffer.alloc(1024);
  let n: number;

  while (true) {
    try {
      n = require('fs').readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      chunks.push(buf.slice(0, n));
    } catch (e) {
      break;
    }
  }

  return Buffer.concat(chunks).toString('utf-8');
}

async function sendToExtractionAPI(data: {
  userPrompt: string;
  assistantResponse: string;
  conversationId: string;
  generationId: string;
  model: string;
  projectPath: string;
  source: string;
}) {
  const config = loadGrovConfig(); // Load from ~/.grov/config.json

  const response = await fetch(`${config.apiUrl}/teams/${config.teamId}/cursor/extract`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.token}`
    },
    body: JSON.stringify(data)
  });

  if (!response.ok) {
    // Log error but don't block
    console.error(`Grov extraction failed: ${response.status}`);
  }
}

function loadGrovConfig() {
  const configPath = join(homedir(), '.grov', 'config.json');
  return JSON.parse(readFileSync(configPath, 'utf-8'));
}
```

### Setup Command Addition

```typescript
// Add to src/cli/commands/setup.ts

export async function setupCursorCliHooks(): Promise<void> {
  const hooksPath = join(homedir(), '.cursor', 'hooks.json');

  let hooks: any = { version: 1, hooks: {} };

  // Load existing hooks if present
  if (existsSync(hooksPath)) {
    hooks = JSON.parse(readFileSync(hooksPath, 'utf-8'));
  }

  // Add grov hooks
  hooks.hooks.beforeSubmitPrompt = hooks.hooks.beforeSubmitPrompt || [];
  hooks.hooks.afterAgentResponse = hooks.hooks.afterAgentResponse || [];

  // Check if grov hooks already exist
  const hasPromptHook = hooks.hooks.beforeSubmitPrompt.some(
    (h: any) => h.command.includes('grov hook prompt')
  );
  const hasResponseHook = hooks.hooks.afterAgentResponse.some(
    (h: any) => h.command.includes('grov hook response')
  );

  if (!hasPromptHook) {
    hooks.hooks.beforeSubmitPrompt.push({ command: 'grov hook prompt' });
  }

  if (!hasResponseHook) {
    hooks.hooks.afterAgentResponse.push({ command: 'grov hook response' });
  }

  writeFileSync(hooksPath, JSON.stringify(hooks, null, 2));
  console.log('✓ Cursor CLI hooks configured');
}
```

---

## File Locations Reference

### Cursor CLI Files

| File | Purpose |
|------|---------|
| `~/.local/bin/cursor-agent` | CLI binary symlink |
| `~/.local/share/cursor-agent/versions/` | Actual binaries |
| `~/.cursor/mcp.json` | MCP server configuration |
| `~/.cursor/hooks.json` | Hooks configuration |
| `~/.cursor/rules/` | Global rules directory |
| `~/.cursor/rules/grov.mdc` | Grov rules (global) |
| `~/.cursor/cli-config.json` | CLI settings |
| `~/.cursor/chats/` | Conversation storage |
| `~/.cursor/chats/{workspace}/{chat}/store.db` | Conversation SQLite |

### Grov Files (Existing)

| File | Purpose |
|------|---------|
| `~/.grov/config.json` | Grov configuration |
| `~/.grov/cursor_synced.json` | IDE sync tracking |
| `~/.grov/cursor_plan_state.json` | IDE plan accumulation |

### Grov Files (New for CLI)

| File | Purpose |
|------|---------|
| `~/.grov/cli_pending.json` | Temporary prompt storage for pairing |
| `~/.grov/cli_synced.json` | CLI sync tracking (optional) |

---

## Testing Checklist

### Manual Testing

```bash
# 1. Verify MCP connection
cursor-agent mcp list
# Expected: grov: ready

# 2. Verify tools available
cursor-agent mcp list-tools grov
# Expected: grov_expand, grov_preview

# 3. Test in conversation
cursor-agent
> "Can you use the grov mcp server?"
# Expected: Model calls grov_preview, shows memories

# 4. After implementing hooks, verify hooks.json
cat ~/.cursor/hooks.json
# Expected: grov hook commands registered

# 5. Test hook execution (tail logs while using CLI)
tail -f ~/.grov/cli.log &
cursor-agent
> "Test prompt"
# Expected: Log entries for prompt capture and response capture
```

### Integration Test

```bash
# Use headless mode for automated testing
cursor-agent --print --approve-mcps "What memories do you have about MCP?"
```

---

## Open Questions

1. **Rate limiting:** Should we debounce rapid conversation exchanges?
2. **Error handling:** What if extraction API is down? Queue for retry?
3. **Privacy:** Should we filter any sensitive data before sending?
4. **Thinking blocks:** `afterAgentThought` hook available - capture reasoning too?

---

## References

- Cursor CLI Install: https://cursor.com/cli
- Cursor Hooks Docs: https://cursor.com/docs/agent/hooks
- Cursor MCP Docs: https://cursor.com/docs/context/mcp
- MCP Protocol: https://modelcontextprotocol.io/
