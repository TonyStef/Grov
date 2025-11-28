# Grov CLI - NPM Hardening Report

**Date:** November 2024 (Updated November 28, 2025)
**Version:** 0.1.0
**Status:** Ready for npm publish (17/19 + 14 additional = 31 issues resolved)

---

## Remaining Issues (Deferred)

### L3: LLM Rate Limiting

**Severity:** Low
**Location:** `src/lib/llm-extractor.ts`
**Status:** Deferred to v0.2

#### What It Is

The `llm-extractor.ts` module makes calls to the OpenAI API (GPT-3.5-turbo) to extract structured reasoning from Claude Code sessions. Currently, there is no rate limiting on these API calls.

#### The Risk

- **Cost exposure:** A runaway process or abuse scenario could result in unexpected OpenAI API costs
- **API throttling:** OpenAI may throttle or temporarily block the API key if too many requests are made
- **Resource exhaustion:** In edge cases, many concurrent grov processes could overwhelm the API

#### Current Code

```typescript
// src/lib/llm-extractor.ts:47-88
export async function extractReasoning(session: ParsedSession): Promise<ExtractedReasoning> {
  const openai = getClient();
  // No rate limiting - calls API directly
  const response = await openai.chat.completions.create({
    model: 'gpt-3.5-turbo',
    max_tokens: 1024,
    messages: [...]
  });
  // ...
}
```

#### Recommended Fix

Add a simple daily call counter stored in SQLite:

```typescript
// Option 1: Daily counter in database
interface RateLimitState {
  date: string;      // YYYY-MM-DD
  call_count: number;
}

const MAX_DAILY_CALLS = 100;

function checkRateLimit(): boolean {
  const today = new Date().toISOString().split('T')[0];
  const state = getRateLimitState();

  if (state.date !== today) {
    resetRateLimitState(today);
    return true;
  }

  return state.call_count < MAX_DAILY_CALLS;
}

// Option 2: Simple in-memory throttle
let lastCallTime = 0;
const MIN_INTERVAL_MS = 1000; // 1 call per second max

async function throttledExtract(session: ParsedSession) {
  const now = Date.now();
  const elapsed = now - lastCallTime;
  if (elapsed < MIN_INTERVAL_MS) {
    await new Promise(r => setTimeout(r, MIN_INTERVAL_MS - elapsed));
  }
  lastCallTime = Date.now();
  return extractReasoning(session);
}
```

#### Why Deferred

- Low priority for v0.1 beta launch
- The LLM extraction is optional (works without OPENAI_API_KEY)
- Typical usage is 1-2 calls per session, not hundreds
- Users control their own API keys and costs

---

### H4: O(n²) Anchor Extraction

**Severity:** Medium (Performance)
**Location:** `src/lib/anchor-extractor.ts:89-204`
**Status:** ~~Closed - False positive~~ **FIXED in Additional Audit**

#### Original Assessment Was WRONG

The original analysis incorrectly concluded this was O(n). Three independent audits (Security, Performance, Code Quality) confirmed it IS O(n²) in worst case:

- **Performance Audit:** "The claim that extractAnchors() is effectively O(n) is demonstrably false. Worst case: 1000 functions triggers ~500 million operations."
- **Security Audit:** "If a file contains thousands of single-line functions, findBlockEnd() is called thousands of times."
- **Code Quality Audit:** "O(n²) character iteration on large files."

The original analysis assumed "anchors are sparse" but in real codebases with many small functions, the worst case is common.

#### Fix Applied

Rewrote `extractAnchors()` with single-pass O(n) algorithm:
- Track open anchors in a stack
- Count braces incrementally as we scan lines
- Close anchors when brace depth returns to start level
- Added `MAX_ANCHORS_PER_FILE = 1000` limit
- Added `MAX_FILE_SIZE = 1MB` limit

**New Complexity:** O(n) - each line visited exactly once.

---

## Additional Security Audit - November 28, 2025

A comprehensive secondary audit using three specialized agents (Security, Performance, Code Quality) identified **14 additional issues** that were missed in the original hardening effort.

### Critical Fixes (1)

| ID | Issue | File | Fix Applied |
|----|-------|------|-------------|
| C1 | JSON Prototype Pollution | `llm-extractor.ts:98` | Sanitize parsed JSON by deleting `__proto__`, `constructor`, `prototype` keys |

### High Priority Fixes (6)

| ID | Issue | File | Fix Applied |
|----|-------|------|-------------|
| H1 | Path Traversal in File Reasoning | `capture.ts:261` | Added `isPathWithinProject()` check before reading files |
| H2 | SQL DoS via Massive File List | `store.ts:299` | Added `MAX_FILES_PER_QUERY = 100` limit |
| H3 | Unvalidated Session ID | `jsonl-parser.ts:99` | Validate session ID matches safe pattern `/^[a-f0-9-]+$/i` |
| H4 | Environment Variable Injection | `hooks.ts:62` | Validate grov path contains only safe characters |
| H5 | Missing Error Boundary | `cli.ts` | Added global `unhandledRejection` and `uncaughtException` handlers |
| H6 | Race Condition in Session State | `store.ts:477` | Wrapped updates in `database.transaction()` |

### Medium Priority Fixes (7)

| ID | Issue | File | Fix Applied |
|----|-------|------|-------------|
| M1 | O(n²) Anchor Extraction | `anchor-extractor.ts:89` | Rewrote with single-pass O(n) algorithm + size limits |
| M2 | Unbounded Keyword Array | `prompt-inject.ts:266` | Added `MAX_KEYWORDS = 100` limit |
| M3 | Silent File Permission Failure | `store.ts:126` | Added warning when chmod fails |
| M4 | File System Race (TOCTOU) | `jsonl-parser.ts:127` | Wrapped stat calls in try-catch for deleted files |
| M5 | No Database Statement Caching | `store.ts:112` | Added statement cache Map with `getCachedStatement()` |
| M6 | Missing Composite Index | `store.ts:200` | Added `idx_file_path_created` index |
| M9 | Uncompiled Regex Patterns | `prompt-inject.ts:234` | Pre-compiled regex patterns at module level |

### Key Findings

1. **H4 Anchor Extraction was INCORRECTLY closed** - All three audits confirmed O(n²) complexity
2. **L3 LLM Rate Limiting deferral is ACCEPTABLE** - All auditors agree
3. **1 Critical vulnerability** found (JSON Prototype Pollution)
4. **Path validation gaps** in multiple files

---

## Fixes Applied This Session (Original)

### Critical Fixes (6)

| ID | Issue | File | Fix Applied |
|----|-------|------|-------------|
| C1 | Database connection leak | `cli.ts` | Added `safeAction()` wrapper with `finally { closeDatabase() }` for all commands |
| C2 | Unhandled promise rejections | `cli.ts` | Wrapped all async actions in try-catch, exits with code 1 on error |
| C3 | API key in error messages | `llm-extractor.ts:30` | Changed to generic "LLM extraction unavailable" message |
| C4 | ReDoS vulnerability | `prompt-inject.ts:218-242` | Replaced complex regex with token-based parsing + 10KB input limit |
| C5 | O(n²) keyword matching | `prompt-inject.ts:256-290` | Build keyword Set once, use O(1) lookups per task |
| C6 | Missing file I/O error handling | `capture.ts` | Already had try-catch wrapping (verified) |

### High Priority Fixes (7)

| ID | Issue | File | Fix Applied |
|----|-------|------|-------------|
| H1 | Unbounded array growth | `jsonl-parser.ts:148-186` | Added `MAX_JSONL_ENTRIES = 10000` limit with early termination |
| H2 | Sync file I/O on startup | `hooks.ts:11,62-99` | Cached grov path after first filesystem lookup |
| H3 | Database init optimization | `store.ts:132-133` | Added `PRAGMA journal_mode = WAL` for concurrent performance |
| H5 | Sensitive data in debug | `capture.ts`, `inject.ts` | Truncated session IDs and task IDs to 8 characters |
| H6 | Missing CLI path validation | `cli.ts:45-47` | Validates `--session-dir` rejects paths containing `..` |
| H7 | Unsafe LLM JSON parsing | `llm-extractor.ts:97-127` | Added runtime type guards for all LLM response fields |
| - | Unclosed stdin listeners | `prompt-inject.ts:122-200` | Added cleanup function + safeResolve pattern |
| - | Race condition in session | `store.ts:437-443` | Changed INSERT to INSERT OR IGNORE |

### Low Priority Fixes (4)

| ID | Issue | File | Fix Applied |
|----|-------|------|-------------|
| L1 | MD5 hash (scanner flags) | `anchor-extractor.ts:238` | Changed to SHA-256 (truncated to 16 chars) |
| L2 | Error path leaks | `init.ts:29-30` | Only shows `error.message`, not full stack trace |
| L4 | Stdin O(n²) concatenation | `prompt-inject.ts:129,156` | Uses `chunks[]` array + `join()` instead of `data += chunk` |
| - | Test organization | `tests/` folder | Moved test files from `src/lib/` to dedicated `tests/` folder |

---

## Security Summary

### Vulnerabilities Addressed

1. **Command Injection** - Previously fixed (removed `execSync('which grov')`)
2. **Path Traversal** - Previously fixed + CLI validation added
3. **SQL Injection** - Previously fixed (parameterized queries + LIKE escaping)
4. **ReDoS** - Fixed (simplified regex patterns)
5. **API Key Exposure** - Fixed (generic error messages)
6. **Memory Exhaustion** - Fixed (entry limits, input size limits)
7. **Information Disclosure** - Fixed (debug redaction, error sanitization)

### Secure Defaults

- Database directory: `0o700` (owner only)
- Database file: `0o600` (owner read/write)
- Settings file: `0o600` (owner read/write)
- No shell command execution
- Input validation on all CLI options

---

## Verification

```bash
# Build
npm run build  # ✅ No TypeScript errors

# Tests
npm test       # ✅ 44/44 tests passing

# Package
npm pack       # ✅ 31 files, ~112 KB
```

---

## Commit Summary

```
feat: npm publishing hardening - security, performance, stability

Security:
- Fix ReDoS in file path regex
- Add API key error message sanitization
- Add LLM response type validation
- Redact sensitive data from debug output
- Add CLI path validation for --session-dir
- Fix race condition with INSERT OR IGNORE

Performance:
- O(n²) → O(n) keyword matching
- O(n²) → O(n) stdin concatenation
- Cache grov path lookup
- Add WAL mode for SQLite
- Add JSONL entry limit (10K max)

Stability:
- Add error handling wrapper for all CLI commands
- Ensure database connections are closed
- Clean up stdin event listeners
- Organize tests into dedicated folder
```
