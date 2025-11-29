<h1 align="center">grov</h1>

<p align="center"><strong>Collective AI memory for engineering teams.</strong></p>

<p align="center">
  <a href="https://grov.dev">Website</a> •
  <a href="#quick-start">Quick Start</a> •
  <a href="#roadmap">Roadmap</a> •
  <a href="#contributing">Contributing</a>
</p>

Grov automatically captures reasoning from your Claude Code sessions and injects relevant context into future sessions. Your AI remembers what it learned.

## The Problem

Every time you start a new Claude Code session:
- Claude re-explores your codebase from scratch
- It reads the same files again
- It rediscovers patterns you've already established
- You burn tokens on redundant exploration

**Measured impact:** A typical task takes 10+ minutes, 7%+ token usage, and 3+ explore agents just to understand the codebase.

## The Solution

Grov captures what Claude learns and injects it back on the next session.

**With grov:** Same task takes ~1-2 minutes, <2% tokens, 0 explore agents. Claude reads files directly because it already has context.

## How It Works

```
Session 1: Claude learns about your auth system
           ↓
        grov captures: "Auth tokens refresh in middleware/token.ts:45,
                        using 15-min window to handle long forms"
           ↓
Session 2: User asks about related feature
           ↓
        grov injects: Previous context about auth
           ↓
        Claude skips exploration, reads files directly
```

**Zero friction.** You don't change anything about how you use Claude Code.

## Quick Start

```bash
# Install globally
npm install -g grov

# One-time setup (registers hooks in Claude Code)
grov init

# Done. Use Claude Code normally.
claude
```

That's it. Grov works invisibly in the background.

## Commands

```bash
grov init        # Register hooks (run once)
grov status      # Show captured tasks for current project
grov status -a   # Show all tasks (including partial/abandoned)
grov unregister  # Disable grov
grov drift-test  # Test drift detection (debug)
```

## How It Actually Works

1. **SessionStart hook** fires when you run `claude`
   - Grov queries its database for relevant past reasoning
   - Outputs context that Claude Code injects into the session

2. **UserPromptSubmit hook** fires on every prompt
   - Monitors Claude's actions (files touched, commands run)
   - Detects scope drift and injects corrections if needed
   - Smart filtering skips simple prompts ("yes", "ok", "continue")

3. **You work normally** with Claude Code

4. **Stop hook** fires when the session ends
   - Grov parses the session's JSONL file
   - Extracts reasoning via LLM (Claude Haiku 4.5)
   - Stores structured summary in SQLite

5. **Next session**, Claude has context and skips re-exploration

## Anti-Drift Detection

Grov monitors what Claude **does** (not what you ask) and warns if it drifts from your original goal.

**How it works:**
- Extracts your intent from the first prompt
- Monitors Claude's actions (file edits, commands, explorations)
- Uses Claude Haiku 4.5 to score alignment (1-10)
- Injects corrections at 5 levels: nudge → correct → intervene → halt

**Key principle:** You can explore freely. Grov watches Claude's actions, not your prompts.

```bash
# Test drift detection manually
grov drift-test "refactor the auth system" --goal "fix login bug"
```

## Environment Variables

```bash
# Required for drift detection and LLM extraction
export ANTHROPIC_API_KEY=sk-ant-...

# Optional: Override drift model (default: claude-haiku-4-5)
export GROV_DRIFT_MODEL=claude-sonnet-4-20250514
```

Without an API key, grov uses basic extraction (files touched, tool usage counts) and disables drift detection.

## What Gets Stored

```json
{
  "task": "Fix auth logout bug",
  "goal": "Prevent random user logouts",
  "files_touched": ["src/auth/session.ts", "src/middleware/token.ts"],
  "reasoning_trace": [
    "Investigated token refresh logic",
    "Found refresh window was too short",
    "Extended from 5min to 15min"
  ],
  "status": "complete",
  "tags": ["auth", "session", "token"]
}
```

## What Gets Injected

```
VERIFIED CONTEXT FROM PREVIOUS SESSIONS:

[Task: Fix auth logout bug]
- Files: session.ts, token.ts
- Extended token refresh window from 5min to 15min
- Reason: Users were getting logged out during long forms

YOU MAY SKIP EXPLORE AGENTS for files mentioned above.
Read them directly if relevant to the current task.
```

## Data Storage

- **Database:** `~/.grov/memory.db` (SQLite)
- **Per-project:** Context is filtered by project path
- **Local only:** Nothing leaves your machine (unless you add cloud sync)

## Requirements

- Node.js 18+
- Claude Code v2.0+

## Roadmap

- [x] Local capture & inject
- [x] LLM-powered extraction (Claude Haiku 4.5)
- [x] Zero-friction hooks
- [x] Per-prompt context injection
- [x] Anti-drift detection & correction
- [ ] Team sync (cloud backend)
- [ ] Web dashboard
- [ ] Semantic search

## Contributing

We welcome contributions! Here's how to get started:

1. **Fork the repo** and clone locally
2. **Install dependencies:** `npm install`
3. **Build:** `npm run build`
4. **Test locally:** `node dist/cli.js --help`

### Development

```bash
# Watch mode for development
npm run dev

# Test the CLI
node dist/cli.js init
node dist/cli.js status
```

### Guidelines

- Keep PRs focused on a single change
- Follow existing code style
- Update tests if applicable
- Update docs if adding features

### Reporting Issues

Found a bug or have a feature request? [Open an issue](https://github.com/TonyStef/Grov/issues).

## License

Apache License 2.0 - see [LICENSE](LICENSE) file for details.
