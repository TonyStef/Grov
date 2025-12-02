# Grov Development Session Context - December 2, 2025

## Purpose of This Document

This document provides complete context for any Claude Code instance continuing work on grov. Read this to understand:
- What grov is and how it works
- What was implemented this session
- Current architectural decisions and debates
- What needs to be done next

---

## What is Grov?

Grov is a **collective AI memory for engineering teams** that works with Claude Code. It:
1. Captures reasoning from Claude Code sessions
2. Stores it in a local SQLite database (`~/.grov/memory.db`)
3. Injects relevant context into future sessions
4. Detects when Claude drifts from the user's goal and corrects it

**Problem solved:** Claude Code re-explores codebases from scratch every session, wasting tokens and time. Grov makes Claude remember what it learned.

---

## Architecture Overview

Grov has TWO systems for interacting with Claude Code:

### 1. Hook System (Original)

Uses Claude Code's hook mechanism to inject commands at specific events:

```
SessionStart hook → grov inject → outputs JSON with past context
UserPromptSubmit hook → grov prompt-inject → per-prompt context + drift check
Stop hook → grov capture → parses JSONL, extracts reasoning, saves to DB
```

**Limitation:** Hooks can only see USER input. They CANNOT see Claude's responses. Drift detection is limited because we can't see what Claude actually does.

### 2. Proxy System (New - Better)

A local HTTP proxy that intercepts ALL Claude API traffic:

```
Claude Code → localhost:8080 (grov proxy) → api.anthropic.com
                    ↓
          - Injects context into requests
          - Parses Claude's responses
          - Detects drift in real-time
          - Tracks token usage
          - Detects task completion
```

**Advantage:** Proxy sees BOTH directions - requests AND responses. It can detect drift based on Claude's actual actions (tool_use blocks), not just user prompts.

---

## What Was Implemented This Session

### 1. Automatic Proxy URL Configuration

**Files modified:**
- `src/lib/hooks.ts` - Added `setProxyEnv()` function
- `src/commands/init.ts` - Calls `setProxyEnv(true)` to add proxy URL
- `src/commands/unregister.ts` - Calls `setProxyEnv(false)` to remove proxy URL

**What it does:**
`grov init` now automatically adds to `~/.claude/settings.json`:
```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8080"
  }
}
```

This means when users run `claude`, it automatically routes through the proxy (if running).

### 2. API Key UX Improvements

**Files modified:**
- `src/commands/init.ts` - Shows helpful message if ANTHROPIC_API_KEY not found
- `src/proxy/index.ts` - Checks for API key before starting, shows instructions
- `src/lib/llm-extractor.ts` - Added `~/.grov/.env` fallback loading

**What it does:**
- `grov init` checks for API key and shows setup instructions if missing
- `grov proxy` fails fast with helpful error if no API key
- Users can store API key in `~/.grov/.env` as alternative to shell profile

### 3. Documentation Updates

**Files modified:**
- `docs/MVP.md` - Complete rewrite reflecting current implementation
- `README.md` - Added proxy documentation throughout

**Key additions:**
- Commands section includes `grov proxy` and `grov proxy-status`
- "Enable Full Features" section explaining proxy
- Two modes explained (hook mode vs proxy mode)
- Environment variables for proxy settings
- Roadmap updated with proxy marked complete

---

## Current State of the Codebase

### File Structure
```
src/
├── cli.ts                    # Entry point - all commands registered
├── commands/
│   ├── init.ts               # Registers hooks + sets ANTHROPIC_BASE_URL
│   ├── capture.ts            # Stop hook - parses JSONL, saves reasoning
│   ├── inject.ts             # SessionStart hook - injects past context
│   ├── prompt-inject.ts      # UserPromptSubmit hook - per-prompt injection
│   ├── status.ts             # Shows tasks for current project
│   ├── unregister.ts         # Removes hooks + ANTHROPIC_BASE_URL
│   ├── drift-test.ts         # Debug command for testing drift detection
│   └── proxy-status.ts       # Shows active proxy sessions
├── proxy/
│   ├── index.ts              # CLI entry for `grov proxy`
│   ├── server.ts             # Fastify HTTP server
│   ├── config.ts             # Proxy configuration
│   ├── forwarder.ts          # Forwards requests to Anthropic via undici
│   ├── action-parser.ts      # Parses tool_use blocks from responses
│   ├── request-processor.ts  # Injects context into requests
│   └── response-processor.ts # Processes responses, saves to DB
└── lib/
    ├── store.ts              # SQLite operations (5 tables)
    ├── hooks.ts              # Hook registration + setProxyEnv()
    ├── llm-extractor.ts      # LLM calls (Haiku for drift, intent)
    ├── drift-checker.ts      # Hook-side drift detection
    ├── drift-checker-proxy.ts    # Proxy-side drift detection
    ├── correction-builder.ts     # Hook-side corrections
    ├── correction-builder-proxy.ts # Proxy-side corrections
    └── ...
```

### Database Schema (5 tables)
1. `tasks` - Team memory (permanent, completed work)
2. `session_states` - Active sessions (temporary)
3. `steps` - Action log per session (proxy uses)
4. `drift_log` - Rejected actions audit
5. `file_reasoning` - File-level reasoning anchors

### Dependencies
- `@anthropic-ai/sdk` - Claude API
- `fastify` - HTTP proxy server
- `undici` - HTTP client for forwarding
- `better-sqlite3` - Local database
- `dotenv` - Environment variable loading

---

## The Architectural Debate (IMPORTANT)

### Current Problem

Right now, `grov init` does TWO things:
1. Registers hooks (SessionStart, UserPromptSubmit, Stop)
2. Sets ANTHROPIC_BASE_URL to localhost:8080

This creates issues:

**Issue 1: Duplication**
- Hooks inject context + Proxy injects context = double injection
- Hooks do drift check + Proxy does drift check = double checking

**Issue 2: Failure Mode**
- If ANTHROPIC_BASE_URL is set but proxy isn't running
- Claude Code tries to connect to localhost:8080
- Connection refused → Claude fails entirely

### The Realization

**Proxy is objectively BETTER than hooks because:**

| Capability | Hooks | Proxy |
|------------|-------|-------|
| Inject context into requests | ✓ | ✓ |
| See Claude's responses | ✗ | ✓ |
| Detect drift from Claude's actions | ✗ | ✓ |
| Real-time token tracking | ✗ | ✓ |
| Parse tool_use blocks | ✗ | ✓ |
| Detect task completion | ✗ | ✓ |

Hooks are BLIND to what Claude does. They only see:
- Session started
- User sent a prompt
- Session ended

Proxy sees EVERYTHING in both directions.

### The Decision (Pending Implementation)

**Remove hooks entirely. Go proxy-only.**

Reasoning:
1. Proxy is more powerful
2. No duplication
3. Cleaner architecture
4. Hooks provide no value that proxy doesn't do better

The only tradeoff is: **users must run `grov proxy` for grov to work.**

---

## What Needs To Be Done Next

### Immediate (Before HN Launch)

1. **Decide: Keep hooks as fallback or remove entirely?**
   - Option A: Remove hooks, go proxy-only
   - Option B: Keep hooks as fallback when proxy not running, but don't set ANTHROPIC_BASE_URL by default

2. **If going proxy-only:**
   - Remove hook registration from `grov init`
   - Keep ANTHROPIC_BASE_URL setting
   - Update `grov init` messaging to tell users to run `grov proxy`
   - Update README to reflect proxy-only architecture

3. **If keeping hooks as fallback:**
   - Remove automatic ANTHROPIC_BASE_URL from `grov init`
   - Add `grov init --proxy` flag for users who want proxy mode
   - Or separate command: `grov enable-proxy` / `grov disable-proxy`

### Post-Launch (Future)

1. **Auto-start proxy as daemon**
   - macOS: launchd plist
   - Linux: systemd user service
   - True zero-friction experience

2. **Fix database schema issue**
   - User reported: `Error: no such column: parent_session_id`
   - Old database missing new columns from proxy implementation
   - Need migration or instruction to delete `~/.grov/memory.db`

---

## Key Files to Read

If you need to understand specific parts:

| Topic | File |
|-------|------|
| All commands | `src/cli.ts` |
| Hook registration | `src/lib/hooks.ts` |
| Proxy server | `src/proxy/server.ts` |
| Proxy config | `src/proxy/config.ts` |
| Database schema | `src/lib/store.ts` |
| LLM calls (drift, intent) | `src/lib/llm-extractor.ts` |
| Detailed proxy architecture | `docs/plan_proxy_local.md` |
| Current MVP status | `docs/MVP.md` |

---

## Environment Setup

For grov to work, users need:

```bash
# Required - for drift detection and LLM extraction
export ANTHROPIC_API_KEY=sk-ant-...

# Alternative - store in file
echo "ANTHROPIC_API_KEY=sk-ant-..." > ~/.grov/.env
```

Current user flow:
```bash
npm install -g grov
grov init           # Registers hooks + sets ANTHROPIC_BASE_URL
grov proxy          # Start proxy (Terminal 1)
claude              # Use Claude Code (Terminal 2)
```

---

## Git History Context

Recent commits on `wel` branch:
```
540aa27 fixead cleanup
6a07599 v1 of local proxy / hook
7fbc849 Merge remote-tracking branch 'origin/wel' into proxy_local
ded4f44 basic local proxy implementation
```

The proxy was developed on `proxy_local` branch and merged into `wel`.

---

## Summary

**Current state:** Grov has both hooks AND proxy, with `grov init` setting up both. This causes duplication and potential failures.

**Pending decision:** Go proxy-only (cleaner, more powerful) or keep hooks as fallback (more complex but works without proxy running).

**The cofounder's position:** Proxy is better, why keep hooks?

**Technical answer:** No good reason to keep hooks if proxy works. The only question is UX - how to ensure proxy is always running. For now, users run `grov proxy` manually. Later, implement auto-start daemon.

---

## Contact / Resources

- npm: https://www.npmjs.com/package/grov
- GitHub: https://github.com/TonyStef/Grov
- Website: https://grov.dev
