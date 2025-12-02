# Session: December 2, 2025 - Hook System Removal

## Summary

Removed the entire hook system from Grov. The codebase is now **proxy-only**. This was done before the Hacker News launch.

---

## Why Hooks Were Removed

The proxy is **strictly superior** to hooks:

| Capability | Hooks | Proxy |
|------------|-------|-------|
| Inject context | Yes | Yes |
| See Claude's responses | **No** | Yes |
| Detect drift from actions | **No** | Yes |
| Track tokens | **No** | Yes |
| Detect task completion | **No** | Yes |
| Real-time correction | **No** | Yes |

Hooks could only see: "session started", "user sent prompt", "session ended". They were **blind** to what Claude actually did.

The proxy intercepts ALL API traffic bidirectionally - it sees both requests AND responses, enabling real-time drift detection based on actual `tool_use` blocks.

**Running both caused problems:**
- Double context injection
- Double drift checking
- If proxy isn't running but `ANTHROPIC_BASE_URL` is set → Claude fails entirely

---

## Files Deleted (7 files, ~1,500 lines)

### Hook Commands
| File | Purpose |
|------|---------|
| `src/commands/inject.ts` | SessionStart hook - injected context |
| `src/commands/capture.ts` | Stop hook - captured reasoning |
| `src/commands/prompt-inject.ts` | UserPromptSubmit hook - per-prompt injection |
| `src/commands/unregister.ts` | Removed hooks from settings |

### Hook Utilities
| File | Purpose |
|------|---------|
| `src/lib/hooks.ts` | Hook registration/unregistration logic |
| `src/lib/drift-checker.ts` | Hook-based drift detection |
| `src/lib/correction-builder.ts` | Hook-based correction messages |

### Tests
| File | Purpose |
|------|---------|
| `tests/hooks.test.ts` | Hook unit tests |

---

## Files Created (2 files)

### `src/lib/settings.ts`
Extracted from `hooks.ts`. Contains only settings-related functions:
- `readClaudeSettings()` - Read `~/.claude/settings.json`
- `writeClaudeSettings()` - Write `~/.claude/settings.json`
- `setProxyEnv(enable)` - Set/remove `ANTHROPIC_BASE_URL`
- `getSettingsPath()` - Return settings path

### `src/commands/disable.ts`
New command to undo `grov init`:
```typescript
import { setProxyEnv, getSettingsPath } from '../lib/settings.js';

export async function disable(): Promise<void> {
  const result = setProxyEnv(false);
  // Removes ANTHROPIC_BASE_URL from settings
}
```

---

## Files Modified (3 files)

### `src/commands/init.ts`
**Before:** Registered 3 hooks + set proxy URL
**After:** Only sets proxy URL (~40 lines)

```typescript
import { setProxyEnv, getSettingsPath } from '../lib/settings.js';

export async function init(): Promise<void> {
  setProxyEnv(true);
  console.log('Grov configured. Run `grov proxy` to start.');
}
```

### `src/commands/drift-test.ts`
**Before:** Used `drift-checker.ts` (hook version)
**After:** Uses `drift-checker-proxy.ts` (proxy version)

Changed imports:
```typescript
// OLD
import { checkDrift } from '../lib/drift-checker.js';
import { buildCorrection } from '../lib/correction-builder.js';

// NEW
import { checkDrift } from '../lib/drift-checker-proxy.js';
import { buildCorrection } from '../lib/correction-builder-proxy.js';
```

Changed mock data from `ClaudeAction[]` to `StepRecord[]`.

### `src/cli.ts`
**Removed commands:** `capture`, `inject`, `prompt-inject`, `unregister`
**Added command:** `disable`

---

## Commands Before vs After

### Before (Hooks + Proxy)
```bash
grov init           # Register hooks + set proxy URL
grov capture        # Stop hook
grov inject         # SessionStart hook
grov prompt-inject  # UserPromptSubmit hook
grov unregister     # Remove hooks
grov proxy          # Start proxy
grov proxy-status   # Show sessions
grov status         # Show tasks
grov drift-test     # Debug drift
```

### After (Proxy Only)
```bash
grov init           # Set proxy URL (run once)
grov disable        # Remove proxy URL
grov proxy          # Start proxy (required)
grov proxy-status   # Show sessions
grov status         # Show tasks
grov drift-test     # Debug drift
```

---

## New User Flow

```bash
# Install
npm install -g grov

# One-time setup
grov init

# Terminal 1: Start proxy (required)
grov proxy

# Terminal 2: Use Claude normally
claude

# To disable
grov disable
```

---

## Architecture Change

### Before
```
Claude Code → Hooks (blind) → Anthropic
                ↓
           grov capture/inject/prompt-inject
```

Hooks could only inject context. They couldn't see Claude's responses or actions.

### After
```
Claude Code → Proxy → Anthropic
                ↓
           Full visibility:
           - Intent extraction
           - Context injection
           - Drift detection
           - Task tracking
           - Token counting
```

The proxy sees everything. It's a superset of hook functionality.

---

## Proxy Capabilities (Reference)

The proxy (`src/proxy/server.ts`) handles:

1. **Intent Extraction** - `extractIntent()` from first prompt
2. **Task Orchestration** - `analyzeTaskContext()` for continue/new_task/subtask/complete
3. **Context Injection** - `buildTeamMemoryContext()` on every request
4. **Drift Detection** - `checkDrift()` every N prompts
5. **Correction Injection** - `buildCorrection()` when score < 8
6. **Recovery Flow** - `generateForcedRecovery()` when escalation >= 3
7. **Token Tracking** - `updateTokenCount()` per response
8. **Step Recording** - `createStep()` for each action
9. **Team Memory Save** - `saveToTeamMemory()` on task complete

All of this was impossible with hooks alone.

---

## Testing

```bash
npm run build
node dist/cli.js --help    # Shows: init, disable, proxy, proxy-status, status, drift-test
node dist/cli.js init      # Sets ANTHROPIC_BASE_URL
node dist/cli.js disable   # Removes ANTHROPIC_BASE_URL
```

---

## Related Files (Not Modified)

These proxy files remain unchanged:
- `src/proxy/server.ts` - Main proxy server
- `src/proxy/request-processor.ts` - Context injection
- `src/proxy/response-processor.ts` - Team memory save
- `src/proxy/action-parser.ts` - Parse tool_use blocks
- `src/proxy/forwarder.ts` - HTTP forwarding
- `src/proxy/config.ts` - Proxy configuration
- `src/lib/drift-checker-proxy.ts` - Proxy-based drift detection
- `src/lib/correction-builder-proxy.ts` - Proxy-based corrections

---

## Commit Summary

```
feat: Remove hook system, go proxy-only

BREAKING CHANGE: Hooks removed entirely

Deleted:
- src/commands/inject.ts
- src/commands/capture.ts
- src/commands/prompt-inject.ts
- src/commands/unregister.ts
- src/lib/hooks.ts
- src/lib/drift-checker.ts
- src/lib/correction-builder.ts
- tests/hooks.test.ts

Created:
- src/lib/settings.ts (extracted from hooks.ts)
- src/commands/disable.ts (new command)

Modified:
- src/commands/init.ts (simplified)
- src/commands/drift-test.ts (use proxy versions)
- src/cli.ts (removed hook commands, added disable)
- README.md (updated for proxy-only)
```
