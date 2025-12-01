# Anti-Drift System Documentation

## Overview

The anti-drift system monitors Claude's ACTIONS (file edits, writes, bash commands) and detects when work deviates from the original goal. When drift is detected, corrections are injected to guide Claude back on track.

---

## Part 1: Hook-Only Implementation (Current)

### New Files Added

| File | Purpose |
|------|---------|
| `src/lib/drift-checker.ts` | Core drift detection logic. Compares files touched against expected scope. Returns score 1-10. |
| `src/lib/correction-builder.ts` | Builds correction messages based on drift severity. Levels: nudge, correct, intervene, halt. |
| `src/lib/session-parser.ts` | Parses Claude Code JSONL session files. Extracts tool calls (Edit, Write, Bash, Read). |

### Modified Files

| File | Changes |
|------|---------|
| `src/lib/store.ts` | Added `session_states` table with: original_goal, expected_scope, drift_history[], escalation_count, last_checked_at |
| `src/commands/prompt-inject.ts` | Added drift check flow: parse JSONL, check actions, build correction, inject via append-system-prompt |
| `src/commands/capture.ts` | Added drift-aware task capture: flags tasks with "needs-review", "had-drift" tags when drift occurred |

### How It All Connects

```
1. SESSION START (SessionStart hook)
   - Fires when Claude Code session begins
   - Extracts goal and expected scope from first user message
   - Creates session_state record in SQLite database
   - No drift check yet (nothing to check)

2. USER PROMPT SUBMIT (UserPromptSubmit hook) - fires on EVERY user message
   - findLatestSessionFile() - locates ~/.claude/projects/<path>/<session>.jsonl
   - parseSession() - reads JSONL, extracts all tool calls
   - getNewActions() - filters to actions since last_checked_at
   - checkDrift(actions) - compares touched files against expected_scope
   - If score < 8: buildCorrection() generates correction message
   - updateSessionDrift() - appends to drift_history, updates escalation_count
   - Outputs correction via --append-system-prompt flag
   - Claude receives correction in next response context

3. SESSION STOP (Stop hook)
   - shouldFlagForReview() - checks drift_history for unresolved issues
   - getDriftSummary() - computes total drift events, final score
   - createTask() - saves task with drift metadata and tags
   - If had drift: adds "needs-review", "had-drift" tags
   - If had HALT-level drift: adds warning to reasoning trace
```

### Drift Detection Logic

The drift checker evaluates Claude's actions against the session's expected scope:

```
Input:
  - claudeActions: [{type: "edit", files: ["src/auth/token.ts"]}, ...]
  - expectedScope: ["src/auth/", "src/lib/"]
  - driftHistory: [{score: 8}, {score: 7}, ...]

Checks:
  1. File scope - Are edited files within expected scope?
  2. Repetition - Same file edited 3+ times? (circling pattern)
  3. Tangent detection - Unrelated work (CSS when goal is auth)
  4. Escalation - Previous corrections ignored?

Output:
  - score: 1-10 (10 = perfect alignment, 1 = complete tangent)
  - type: none | minor | major | critical
  - diagnostic: explanation of what drifted
  - recoveryPlan: suggested steps to return to goal
```

### Correction Levels

| Score | Level | Action |
|-------|-------|--------|
| 8-10 | none | No correction, continue normally |
| 7 | nudge | Brief reminder of goal and scope |
| 5-6 | correct | Full correction with recovery steps |
| 3-4 | intervene | Strong correction, verification required |
| 1-2 | halt | Critical stop, mandatory first action specified |

### Escalation Tracking

```
First drift (score 6): Level = correct
Second drift (score 5): Level = intervene (escalated)
Third drift (score 4): Level = halt (maximum escalation)

If Claude recovers (score 8+): escalation_count decreases
```

### Database Schema

```sql
CREATE TABLE session_states (
  session_id TEXT PRIMARY KEY,
  project_path TEXT,
  original_goal TEXT,
  expected_scope JSON,        -- ["src/auth/", "src/lib/"]
  constraints JSON,           -- ["don't modify schema"]
  keywords JSON,              -- ["auth", "token", "bug"]
  drift_history JSON,         -- [{score, level, timestamp}, ...]
  escalation_count INTEGER,
  last_checked_at INTEGER,
  status TEXT,                -- active | completed | abandoned
  created_at TEXT,
  updated_at TEXT
);
```

---

## Part 2: Limitation of Hook-Only Approach

### The Timing Problem

Hooks only fire at specific moments:
1. SessionStart - once at beginning
2. UserPromptSubmit - when user sends a message
3. Stop - when session ends

This means:
- When UserPromptSubmit fires, Claude has ALREADY completed its previous actions
- We detect drift AFTER it happened
- Correction is injected for the NEXT turn
- Claude might continue drifting before user speaks again

### Example Timeline

```
T1: User asks "fix auth bug"
T2: Claude edits src/auth/token.ts (on track)
T3: Claude edits src/styles/theme.css (DRIFT - but no hook fires)
T4: Claude edits src/components/Button.tsx (MORE DRIFT - still no hook)
T5: User sends "looks good"
    -> UserPromptSubmit hook fires
    -> We detect drift from T3 and T4
    -> Inject correction
T6: Claude receives correction, hopefully adjusts
```

The drift at T3-T4 was not caught until T5. Two drifted actions already happened.

---

## Part 3: Full Proxy Implementation (Future Plan)

### How Proxy Differs

With a proxy intercepting all Claude Code traffic:

| Aspect | Hook (current) | Proxy (planned) |
|--------|----------------|-----------------|
| Timing | Check on user message | Check on EVERY action |
| Detection | After Claude finished | Real-time, as it happens |
| Correction | Next user turn | Immediately after action |
| Blocking | Cannot stop actions | Can block before execution |
| Context | Only tool calls from JSONL | Full access: reasoning, thinking blocks |
| Granularity | Batch (all actions since last check) | Per-action |

### Proxy Flow (from deep_dive.md)

```
1. USER REQUEST arrives
   -> Proxy intercepts
   -> Extract intent, create session state
   -> Forward to Claude

2. CLAUDE ACTION (each Edit/Write/Bash)
   -> Proxy intercepts response
   -> Parse action details
   -> Run drift check immediately
   -> If score >= 8: save step, forward to user
   -> If score 5-7: save step with drift metadata, inject nudge/correct
   -> If score 1-4: DO NOT save step, inject intervene/halt, pause

3. DRIFT DETECTED (score < 5)
   -> Pause saving (don't pollute history with bad steps)
   -> Inject strong correction
   -> Wait for Claude's next action
   -> Verify it follows recovery plan
   -> If recovered: resume normal operation
   -> If still drifting: escalate, force specific action

4. SESSION END
   -> Capture task with full drift summary
   -> Flag for review if had unresolved drift
```

### 4-Query Retrieval Strategy

For proxy version, drift checker retrieves relevant past steps:

```sql
-- Query 1: Exact file match
SELECT * FROM steps WHERE files @> ARRAY[current_files] AND drift_score >= 5

-- Query 2: Same folder
SELECT * FROM steps WHERE folders @> ARRAY[current_folders] AND drift_score >= 5

-- Query 3: Keyword match
SELECT * FROM steps WHERE keywords && ARRAY[goal_keywords] AND drift_score >= 5

-- Query 4: Key decisions
SELECT * FROM steps WHERE is_key_decision = true

-> Deduplicate, prioritize, take top 10 for context
```

### Steps Table (Proxy Version)

```sql
CREATE TABLE steps (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  action_type TEXT,           -- edit, write, bash, read
  files JSON,
  folders JSON,
  command TEXT,               -- for bash actions
  reasoning TEXT,
  drift_score INTEGER,
  drift_type TEXT,            -- none, minor, major, critical
  correction_given TEXT,
  is_key_decision BOOLEAN,
  is_validated BOOLEAN,       -- false if score < 5 (not saved to main history)
  keywords JSON,
  timestamp INTEGER
);
```

### Session State Machine (Proxy)

```
         +--------+
         | START  |
         +---+----+
             |
             v
         +--------+
    +--->| NORMAL |<---+
    |    +---+----+    |
    |        |         |
    |  score < 5       | score >= 5 (recovered)
    |        |         |
    |        v         |
    |    +---------+   |
    |    | DRIFTED |---+
    |    +----+----+
    |         |
    |   escalation >= 3
    |         |
    |         v
    |    +--------+
    |    | FORCED |
    |    +---+----+
    |        |
    +--------+ (forced action executed)
```

### Correction Injection Points

Hook version:
- Single injection point: UserPromptSubmit hook
- Method: --append-system-prompt flag

Proxy version:
- Multiple injection points: after any action
- Method: modify response before forwarding
- Can inject mid-conversation, not just at turn boundaries

---

## Part 4: Summary

### What Anti-Drift Adds to Grov

Before: Grov provided memory and context injection only
After: Grov monitors Claude's work and corrects deviations

### Hook Version Trade-offs

Pros:
- No infrastructure changes (uses Claude Code hooks)
- Works with existing Claude Code installation
- Simpler implementation

Cons:
- Detection delayed until next user message
- Cannot block actions in real-time
- Limited to JSONL parsing (no reasoning access)

### Proxy Version Benefits

- Real-time detection and correction
- Can block bad actions before they take effect
- Full visibility into Claude's reasoning
- Per-action granularity
- Recovery verification loop
- Pause saving for major drift (clean history)

### Key Insight

Hook version: "Look back, correct forward"
Proxy version: "Intercept everything, correct instantly"

Both achieve the same goal (keep Claude on track) but proxy version is more responsive and can prevent drift rather than just correct it after the fact.
