# Project: Collective AI Memory for Engineering Teams

## One-Line Summary
A CLI wrapper for Claude Code that captures reasoning from AI coding sessions and injects relevant team context into new sessions, eliminating redundant codebase exploration and preserving institutional knowledge.

---

## Problem Statement

### The Pain
When developers use AI coding agents (Claude Code, Cursor, etc.):
1. **Context degradation**: Agents get "dumber" over long sessions as context fills up
2. **Redundant exploration**: Every new session re-explores the same codebase patterns
3. **Lost reasoning**: The "why" behind decisions disappears when sessions end
4. **No team memory**: Dev B's Claude doesn't know what Dev A's Claude learned yesterday

### Who Feels This Most
- Teams of 5+ developers on complex codebases
- Onboarding new engineers (their AI has zero context)
- Codebases with legacy decisions that aren't documented
- Teams burning tokens on repeated exploration

### Quantified Problem (from tonight's testing)
- Baseline Claude Code task: 10-11 minutes, 7%+ usage, 3+ explore agents, 10+ files read
- With system-level context injection: ~1-2 minutes to plan, 1.6k tokens, 0 explore agents, 3-4 files read

---

## Solution (Validated)

### Core Insight
Claude Code respects `--append-system-prompt` flag. When you inject verified context at the system level (not user level), Claude:
- Skips mandatory exploration agents
- Directly reads only the files mentioned
- Trusts the provided context as verified
- Proceeds to implementation faster

### How It Works

```
┌─────────────────────────────────────────────────────────────┐
│                      YOUR TOOL                              │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  1. CAPTURE (after each Claude Code session):               │
│     - Thinking blocks (reasoning)                           │
│     - Intent object (goal, constraints, approach)           │
│     - Files touched                                         │
│     - Patterns used                                         │
│     - Key decisions + rejected alternatives                 │
│                                                             │
│  2. STORE:                                                  │
│     - Local DB or cloud (team sync)                         │
│     - Tagged by: files, modules, task type                  │
│     - Searchable by semantic similarity                     │
│                                                             │
│  3. RETRIEVE (when new task starts):                        │
│     - Query: "What reasoning exists for files/modules       │
│       related to this task?"                                │
│     - Pull relevant past session context                    │
│                                                             │
│  4. INJECT:                                                 │
│     - Construct system prompt with verified context         │
│     - Call: claude --append-system-prompt "{context}" "task"│
│     - Claude skips exploration, uses provided patterns      │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## Technical Findings (from experiments)

### What Works
- `--append-system-prompt` flag changes Claude Code behavior
- System-level instructions override plan mode's "always explore first" default
- Claude explicitly acknowledges: "The user explicitly told me NOT to use explore agents since they've already verified the context"
- Direct file reads instead of spawning explore agents

### What Doesn't Work
- User-level context injection (in the prompt itself) gets deprioritized
- Claude's plan mode has hardcoded behavior: "Since I'm in plan mode, I should launch explore agents"
- User context is acknowledged but then ignored in favor of system instructions

### Key Discovery
```bash
# This changes Claude's behavior:
claude --append-system-prompt "VERIFIED CONTEXT: Rate limiting pattern is in middleware/rateLimits.ts. Follow leadExportRateLimit. Bulk-update route is at properties.routes.ts line 98. DO NOT launch explore agents for these files." "add rate limiting to bulk-update"

# Result: 0 explore agents, direct file reads, ~80% faster
```

---

## What To Capture Per Session

### Reasoning Summary Structure
```
TASK: [Short description]

GOAL:
[1-2 sentences]

PATTERNS USED:
- [Pattern name] from [specific file:line]
- [Pattern name] from [specific file:line]

KEY DECISIONS:
- [Decision and why]
- [Considered X but chose Y because Z]

CONSTRAINTS DISCOVERED:
- [What can't break]
- [What must stay compatible]

FILES TOUCHED:
- [file path] ([what was added/changed])

OUTCOME:
- Working / Partial / Failed
- [Any issues encountered]
```

### What NOT to Store
- Full thinking blocks (too verbose)
- Actual code diffs (git has that)
- Every single action (just meaningful ones)

---

## Critical Design Decisions (Resolved)

### Atomic Unit: TASK, not SESSION

**The Problem:**
```
Developer A opens Claude Code at 9am
  - 9:15 "fix auth bug"
  - 10:30 "add rate limiting to API"
  - 11:45 "refactor user service"
  - 12:00 closes Claude Code
```

Is that ONE atomic unit? No. Those are three completely unrelated tasks. If Developer B's Claude retrieves "Developer A's session," they get a blob of mixed reasoning.

**The Solution:** Store per TASK, not per session.

A task could be:
- Explicitly marked ("hey claude, new task: ...")
- Inferred from silence gaps (10+ min break = new task?)
- Tied to a git branch or commit
- Tied to an issue/ticket ID

**Why this matters:** Retrieval becomes "What reasoning exists about *this area of the codebase* or *this type of problem*?" NOT "What did Jake do yesterday?"

### Data Model Per Task

```json
{
  "task_id": "uuid",
  "timestamp": "...",
  "user": "developer_a",
  "original_query": "fix auth bug where users get logged out",
  "intent_object": {
    "goal": "...",
    "success_criteria": [...],
    "constraints": [...]
  },
  "reasoning_trace": [
    // condensed thinking blocks, not raw
    "investigated token refresh logic",
    "found issue in refresh window calculation",
    "considered but rejected changing session table"
  ],
  "files_touched": ["auth/session.js", "middleware/token.js"],
  "status": "complete",           // or "question" | "partial" | "abandoned"
  "linked_commit": "abc123",      // optional
  "tags": ["auth", "middleware"]  // auto-generated from files/query
}
```

The reasoning trace is a **distillation**, not a transcript.

### Task Boundary Detection

**The Problem:** `Stop` hook fires on every Claude response, not just task completion.

| Scenario | Task Done? |
|----------|------------|
| Claude finishes implementing | Yes |
| Claude asks clarifying question | No - waiting |
| User interrupts mid-work | No - abandoned |
| Claude hits error and stops | No - partial |

**The Solution:** LLM classification on each Stop event:

```
When Stop hook fires:
1. Get last few exchanges
2. Send to Claude Haiku: "Classify: COMPLETE | QUESTION | PARTIAL | ABANDONED"
3. Store with that status field
4. Only inject context from COMPLETE tasks
```

### Multi-Turn Task Handling

For tasks that span multiple exchanges:
```
User: "fix auth bug"
Claude: works... asks question
→ Stop fires → status: QUESTION → store but don't inject yet

User: "yes, use JWT"
Claude: finishes implementation
→ Stop fires → status: COMPLETE → merge with previous, now usable
```

Link continuations via `parent_task_id` field.

### Why Tags AND Per-Task?

```
Tags (for organization):           Tasks (atomic units):
┌─────────────────┐               ┌────────────────────────────┐
│ auth            │──────────────▶│ Task: fix token expiry     │
│                 │               │ Decision: extended window  │
│                 │               ├────────────────────────────┤
│                 │──────────────▶│ Task: add 2FA              │
│                 │               │ Decision: TOTP not SMS     │
└─────────────────┘               └────────────────────────────┘
```

- **Tags** = organization ("show me all auth reasoning")
- **Per-task** = granularity (specific decisions for specific problems)
- **Query** = "Get auth tasks touching session.js" → precise context

---

## Zero-Friction Architecture (Validated)

### How Users Install
```bash
npm install -g grov
grov init  # Registers hooks in ~/.claude/settings.json
```

That's it. User never thinks about grov again.

### How It Works (Invisible to User)

1. User runs: `claude "add rate limiting"`
2. **SessionStart hook fires** → grov injects relevant past reasoning via `additionalContext`
3. Claude sees context, skips explore agents, reads files directly
4. User works normally
5. **Stop hook fires** → grov parses JSONL, classifies task status, extracts reasoning, stores
6. Repeat. Context compounds over time.

### The Key Technical Discovery

**SessionStart hooks support `additionalContext`** output:
```json
{
  "hookSpecificOutput": {
    "additionalContext": "VERIFIED CONTEXT FROM PREVIOUS SESSIONS:\n[Task: Add bulk property status update]\n- Rate limiting: middleware/rateLimits.ts:45\n- Decision: Used token bucket because...\n\nYOU MAY SKIP EXPLORE AGENTS for these files."
  }
}
```

This injects directly into Claude's awareness. No wrapper needed - pure hooks.

### Where Session Data Lives

JSONL files at: `~/.claude/projects/<encoded-path>/<session-id>.jsonl`

Format:
```json
{"type":"user","message":{"role":"user","content":"add rate limiting"},"timestamp":"..."}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"..."}]},"timestamp":"..."}
```

Plus tool calls, thinking blocks, etc. Parse this to extract reasoning.

---

## MVP Scope

### Phase 1: CLI Wrapper (Week 1-2)
Build a CLI that:
1. Wraps `claude` command
2. After session ends, prompts user to save reasoning summary (or auto-extracts)
3. Stores to local JSON/SQLite
4. On new session, retrieves relevant context by file path matching
5. Injects via `--append-system-prompt`

```bash
# User runs:
yourtool "add rate limiting to bulk-update"

# Tool does:
# 1. Queries local store: "any reasoning touching properties.routes.ts or rateLimits.ts?"
# 2. Finds relevant past session
# 3. Constructs system prompt
# 4. Executes: claude --append-system-prompt "{context}" "add rate limiting to bulk-update"
```

### Phase 2: Team Sync (Week 3-4)
- Cloud storage option
- Team dashboard showing sessions
- Reasoning shared across team members' machines

### Phase 3: Smart Retrieval (Week 5-6)
- Embedding-based semantic search
- Auto-tagging by module/domain
- Relevance scoring

---

## Open Questions

### Technical
1. How to auto-extract reasoning from Claude Code sessions? (OpenTelemetry integration exists)
2. Optimal format for system prompt injection?
3. How much context is too much? (token limits)

### Product
1. Local-first vs cloud-first?
2. Open source the core, monetize team features?
3. Pricing model: per-seat? usage-based?

### Validation Needed
1. Does this work across different task types?
2. How does retrieval quality affect outcomes?
3. What's the failure mode when wrong context is injected?

---

## Competitive Landscape

### What Exists
- Claude Code's built-in planning (local, ephemeral, single-user)
- CLAUDE.md project files (static, manual)
- Git commit messages (just "what", not "why")

### What Doesn't Exist
- Shared AI reasoning across team
- Automatic context injection from past sessions
- "Institutional memory" for AI agents

---

## Revenue Model (Future)

| Tier | Price | Features |
|------|-------|----------|
| Free | $0 | Local storage, single user, 100 sessions |
| Pro | $20/mo | Cloud sync, unlimited sessions |
| Team | $50/seat/mo | Shared reasoning, dashboard, analytics |
| Enterprise | Custom | SSO, on-prem, compliance |

Real value prop: "Save 40%+ on AI token costs by eliminating redundant exploration"

---

## Next Steps

1. **Build minimal CLI wrapper** - just capture + inject, no fancy retrieval
2. **Test on real workflow** - use it yourself for a week
3. **Measure** - token savings, time savings, quality difference
4. **Iterate** - what context format works best?
5. **Share with 5 devs** - get feedback before building more

---

## Key Insight To Remember

> "Git stores WHAT changed. Commit messages poorly explain WHY. Your product stores the AI's reasoning—the WHY behind every decision—and makes it retrievable for future sessions and team members."

This is "Git for reasoning."

---

## Session Log (Tonight's Experiments)

### Experiment 1: Baseline Task
- Task: Add bulk property status update endpoint
- Result: Claude completed in ~3 min with full codebase context
- Generated reasoning summary for injection testing

### Experiment 2: Related Task Without Context (Run A)
- Task: Add rate limiting to bulk-update endpoint
- Fresh session, no injected context
- Result: 10-11 min, 7%+ usage, 3+ explore agents, 10+ files read

### Experiment 3: User-Level Context Injection (Run B)
- Same task, context injected in user prompt
- Result: Claude acknowledged context but still launched explore agents
- "Since I'm in plan mode, I should..." overrode user context
- ~10 min, similar token usage

### Experiment 4: System-Level Context Injection (Run C)
- Same task, context via `--append-system-prompt`
- Result: **0 explore agents**, direct file reads, ~1-2 min to plan
- Claude said: "The user explicitly told me NOT to use explore agents since they've already verified the context"
- **Hypothesis validated**

---

## Contact / Credits

Research session: [Your name]
Date: [Tonight's date]
Built during exploration of AI agent infrastructure opportunities
