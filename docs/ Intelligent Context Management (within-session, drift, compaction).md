# Project: Intelligent Context Management for AI Coding Agents

## Relationship to Collective AI Memory
This is the **second pillar** of the product. While Collective AI Memory handles **cross-session** knowledge (team memory), this handles **within-session** intelligence (keeping agents on track and managing context efficiently).

```
┌─────────────────────────────────────────────────────────────┐
│                    FULL PRODUCT VISION                      │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  PILLAR 1: Collective AI Memory                             │
│  └─ Cross-session, cross-team knowledge                     │
│  └─ "What did we learn yesterday?"                          │
│                                                             │
│  PILLAR 2: Intelligent Context Management  ← THIS DOC       │
│  └─ Within-session optimization                             │
│  └─ "Keep the agent smart and on-track"                     │
│                                                             │
│  Together: 10x developer productivity with AI agents        │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## Problem Statement

### The Pain
1. **Context degradation**: AI agents get measurably dumber as context window fills
2. **Manual compaction is painful**: Takes 2-3 minutes, burns tokens, breaks flow
3. **Lost reasoning on compact**: Compaction preserves WHAT was decided, loses WHY
4. **Drift without detection**: Agent goes off-task, user doesn't notice until damage is done
5. **No early warning**: By the time you realize the agent is confused, you've wasted tokens and time

### The "Lost in the Middle" Problem
Research shows LLMs retrieve information well from the beginning and end of context, but poorly from the middle. As sessions grow:
- Early reasoning gets "buried"
- Agent loses track of original intent
- Quality of output degrades
- User compensates by manually re-explaining things

### Current User Workflow (Broken)
```
1. Start session with clear goal
2. Agent works well initially
3. Context fills up over time
4. Agent starts making mistakes, forgetting constraints
5. User notices something is wrong
6. User manually triggers /compact
7. Compaction runs (burns tokens, takes 2-3 min)
8. Agent comes back "dumber" - lost important reasoning
9. User has to re-explain context
10. Repeat
```

---

## Solution

### Core Components

#### 1. Intent Extraction (Session Start)
Before the agent starts working, capture structured intent:

```json
{
  "task_id": "uuid",
  "original_query": "Fix auth bug where users get logged out after 5 mins",
  "goal": "Session persists beyond 5 min timeout",
  "success_criteria": [
    "Token refresh logic works correctly",
    "No regression in existing auth flows"
  ],
  "constraints": [
    "Don't modify user table schema",
    "Keep backward compat with mobile app"
  ],
  "expected_scope": ["auth/", "middleware/session.js"]
}
```

This is the **north star** for drift detection. Not the raw query - the expanded intent.

#### 2. Drift Detection (Continuous)
Monitor agent actions against intent:

**Signals that indicate drift:**
- Editing files outside expected scope without justification
- Actions that don't map to any success criterion
- Repeated edits to same file (circular behavior)
- Agent hedging/uncertain language increasing
- Semantic distance between recent actions and original goal

**Detection methods:**
- **Embedding similarity**: Embed intent, embed each action's reasoning, measure cosine distance
- **Scope violation**: File touched not in expected_scope? Flag it.
- **Behavioral patterns**: Same file edited 3+ times? Circular. Flag it.
- **Lightweight classifier**: After every N actions, ask a cheap/fast model "Rate 1-10: how on-track is this?"

#### 3. Smart Compaction (Automated)
When context is getting full OR drift is detected:

**What to preserve:**
- Original intent object (always)
- Key decisions and their reasoning
- Constraints discovered during session
- Current state of the task

**What to drop:**
- Verbose exploration that led nowhere
- Redundant file reads
- Superseded reasoning (if approach changed)

**How it differs from default /compact:**
- Preserves WHY, not just WHAT
- Structures the summary around intent
- Injects preserved reasoning back in optimal format

#### 4. Reasoning Injection (On Compact)
After compaction, inject preserved context:

```
PRESERVED CONTEXT FROM THIS SESSION:

Original Goal: Fix auth bug - session timeout at 5 min

Key Decisions Made:
- Issue is in token refresh window calculation (not session table)
- Using existing refreshToken pattern from auth.service.ts
- Chose to modify middleware, not create new endpoint

Constraints:
- Don't touch user table schema
- Mobile app backward compat required

Current State:
- Identified root cause in auth/tokenRefresh.ts:47
- About to implement fix

Continue from here.
```

---

## System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                   WITHIN-SESSION FLOW                       │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  USER QUERY                                                 │
│       │                                                     │
│       ▼                                                     │
│  ┌─────────────┐                                            │
│  │   INTENT    │ ──→ Store as north star                    │
│  │ EXTRACTION  │                                            │
│  └─────────────┘                                            │
│       │                                                     │
│       ▼                                                     │
│  ┌─────────────┐      ┌─────────────┐                       │
│  │   AGENT     │ ◄──► │   DRIFT     │                       │
│  │   WORKS     │      │  DETECTOR   │                       │
│  └─────────────┘      └─────────────┘                       │
│       │                     │                               │
│       │              Drift detected?                        │
│       │                     │                               │
│       │               ┌─────┴─────┐                         │
│       │               ▼           ▼                         │
│       │            Alert      Auto-correct                  │
│       │            User       (inject reminder)             │
│       │                                                     │
│       ▼                                                     │
│  Context filling up?                                        │
│       │                                                     │
│       ▼                                                     │
│  ┌─────────────┐                                            │
│  │   SMART     │ ──→ Preserve reasoning                     │
│  │  COMPACT    │ ──→ Drop noise                             │
│  └─────────────┘ ──→ Inject structured context              │
│       │                                                     │
│       ▼                                                     │
│  Agent continues with preserved intelligence                │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## Implementation Approach

### Phase 1: Manual Intent + Simple Drift Alert
- User confirms/edits intent object at session start
- Simple drift detection: embedding distance from intent
- Alert user when drift detected (they decide what to do)
- No auto-compaction yet

### Phase 2: Auto-Compaction with Reasoning Preservation
- Detect when context is filling up
- Auto-generate reasoning summary
- Trigger compaction with preserved context injection
- Measure: Does agent maintain quality post-compact?

### Phase 3: Proactive Drift Correction
- Instead of just alerting, inject correction:
  "Reminder: Your goal is X. Recent actions seem to be drifting toward Y. Refocus."
- Learn from user feedback: when did corrections help vs. annoy?

---

## Key Technical Questions

### How to detect "context is filling up"?
- Track token count per request (visible in API response)
- Threshold: e.g., 80% of max context window
- Or: performance degradation signal (response quality metric?)

### How to measure drift quantitatively?
```python
# Simple approach
intent_embedding = embed(intent_object)
action_embedding = embed(recent_action_reasoning)
drift_score = 1 - cosine_similarity(intent_embedding, action_embedding)

if drift_score > 0.4:  # Threshold TBD through testing
    alert_or_correct()
```

### How to inject without breaking agent flow?
Options:
- Modify system prompt mid-session (if possible via proxy)
- Inject as a "system message" in conversation
- Use CLAUDE.md dynamic updates
- Wrapper that intercepts and augments

### How to preserve reasoning through compaction?
- Before triggering /compact, extract key reasoning to external store
- After compaction completes, inject preserved reasoning
- Alternative: Build custom compaction that replaces /compact entirely

---

## Integration with Pillar 1 (Collective AI Memory)

The two pillars share infrastructure:

```
SHARED:
- Reasoning extraction logic
- Storage format for intent + decisions
- Injection mechanism (--append-system-prompt)

PILLAR 1 SPECIFIC:
- Cross-session retrieval
- Team sync
- Semantic search across all sessions

PILLAR 2 SPECIFIC:
- Real-time drift detection
- Context fullness monitoring
- Auto-compaction triggers
```

Build Pillar 1 first → the reasoning capture infrastructure serves both.

---

## User Experience Vision

### Before (Current Pain)
```
Developer: *working with Claude Code for 30 min*
Claude: *starts making mistakes, forgetting earlier constraints*
Developer: "Why did you change that? We discussed this!"
Claude: "I apologize, I don't see that in my context..."
Developer: *sighs, runs /compact, waits 3 min*
Claude: *comes back, has forgotten important reasoning*
Developer: *re-explains everything*
```

### After (With Your Tool)
```
Developer: *working with Claude Code for 30 min*
Tool: [Drift detected - agent editing outside scope]
Tool: [Auto-injecting reminder about original constraints]
Claude: "Right, I need to stay within auth/ - let me refocus."
...
Tool: [Context at 75% - preparing smart compaction]
Tool: [Preserving: intent, 3 key decisions, current state]
Tool: [Compacting with reasoning preservation...]
Claude: *continues seamlessly with full context of WHY*
Developer: *never interrupted, never re-explains*
```

---

## Metrics to Track

### Efficiency
- Tokens saved vs. manual compaction
- Time saved (no manual re-explanation)
- Number of compactions needed per session

### Quality
- Task completion rate post-compaction
- User interventions required (re-explanations)
- Drift detection accuracy (false positives vs. missed drifts)

### User Satisfaction
- "Did the agent maintain quality throughout?" (1-10)
- "Did you have to re-explain context?" (Y/N)
- Net Promoter Score

---

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Drift detection too sensitive (false alarms) | Start conservative, let users tune threshold |
| Auto-correction annoys user | Make it optional, show value before auto-enabling |
| Preserved reasoning is wrong/stale | Let user review before injection |
| Competes with Anthropic's improvements | Position as "power user layer", not replacement |

---

## The 10x Developer Promise

```
CURRENT STATE:
- Developer + AI agent = 2-3x productivity
- But degraded by: context loss, drift, manual compaction
- Net: Maybe 1.5-2x after friction

WITH YOUR TOOL:
- AI agent stays smart throughout session (no degradation)
- Context preserved across sessions (team memory)
- No manual compaction (time saved)
- Institutional knowledge compounds (gets better over time)
- Net: Actual 5-10x productivity
```

---

## Next Steps (After Pillar 1 MVP)

1. Add intent extraction to CLI wrapper
2. Implement simple embedding-based drift detection
3. Test: Alert user on drift, measure if it helps
4. Build smart compaction as alternative to /compact
5. Integrate with reasoning store from Pillar 1

---

## Key Insight

> "Current AI agents are like employees with amnesia. Every session, every compaction, they forget. You're building the tool that gives them persistent, reliable memory - both within sessions (context management) and across sessions (collective memory). That's what makes the 10x promise real."
