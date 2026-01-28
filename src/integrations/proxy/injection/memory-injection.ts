import type { Memory, PlanInjectionContext, PlanInjectionTask } from '@grov/shared';

export interface InjectionRecord {
  position: number;
  type: 'preview' | 'tool_cycle';
  preview?: string;
  toolUse?: { id: string; name: string; input: unknown };
  toolResult?: string;
}

export interface SessionInjectionState {
  memoriesById: Map<string, Memory>;
  injectionHistory: InjectionRecord[];
  pendingRecords: InjectionRecord[];
  lastOriginalMsgCount: number;
  cachedPreview?: { preview: string; msgCount: number };
}

const sessionState = new Map<string, SessionInjectionState>();

function createEmptyState(): SessionInjectionState {
  return {
    memoriesById: new Map(),
    injectionHistory: [],
    pendingRecords: [],
    lastOriginalMsgCount: 0,
  };
}

export function getOrCreateState(sessionId: string): SessionInjectionState {
  if (!sessionState.has(sessionId)) {
    sessionState.set(sessionId, createEmptyState());
  }
  return sessionState.get(sessionId)!;
}

export function clearSessionState(sessionId: string): void {
  sessionState.delete(sessionId);
}

export function cacheMemories(sessionId: string, memories: Memory[]): void {
  const state = getOrCreateState(sessionId);
  state.memoriesById = new Map();
  for (const memory of memories) {
    state.memoriesById.set(memory.id, memory);
  }
}

const MEMORY_ID_PREFIX_LENGTH = 8;

export function getCachedMemoryById(sessionId: string, memoryId: string): Memory | null {
  const state = sessionState.get(sessionId);
  if (!state?.memoriesById) {
    return null;
  }

  if (state.memoriesById.has(memoryId)) {
    return state.memoriesById.get(memoryId) || null;
  }

  for (const [id, memory] of state.memoriesById) {
    const idPrefix = id.substring(0, MEMORY_ID_PREFIX_LENGTH);
    if (id.startsWith(memoryId) || memoryId.startsWith(idPrefix)) {
      return memory;
    }
  }

  return null;
}

export function setCachedPreview(sessionId: string, preview: string, msgCount: number): void {
  const state = getOrCreateState(sessionId);
  state.cachedPreview = { preview, msgCount };
}

export function getCachedPreview(sessionId: string, currentMsgCount: number): string | null {
  const state = sessionState.get(sessionId);
  if (!state?.cachedPreview) return null;
  if (state.cachedPreview.msgCount !== currentMsgCount) return null;
  return state.cachedPreview.preview;
}

// Add record to PENDING (not committed yet - waits for next turn)
export function addInjectionRecord(sessionId: string, record: InjectionRecord): void {
  const state = getOrCreateState(sessionId);
  state.pendingRecords.push(record);
}

export function commitPendingRecords(sessionId: string): number {
  const state = sessionState.get(sessionId);
  if (!state || state.pendingRecords.length === 0) {
    return 0;
  }

  const count = state.pendingRecords.length;
  state.injectionHistory.push(...state.pendingRecords);
  state.pendingRecords = [];
  return count;
}

function hasToolCycleInRecords(records: InjectionRecord[], position: number): boolean {
  return records.some(r => r.type === 'tool_cycle' && r.position === position);
}

export function hasToolCycleAtPosition(sessionId: string, position: number): boolean {
  const state = sessionState.get(sessionId);
  if (!state) {
    return false;
  }

  return hasToolCycleInRecords(state.injectionHistory, position) ||
         hasToolCycleInRecords(state.pendingRecords, position);
}


const MS_PER_DAY = 1000 * 60 * 60 * 24;
const DAYS_PER_WEEK = 7;
const DAYS_PER_MONTH = 30;

export function formatAge(updatedAt: string | undefined): string {
  if (!updatedAt) {
    return 'unknown';
  }

  const diffMs = Date.now() - new Date(updatedAt).getTime();
  const diffDays = Math.floor(diffMs / MS_PER_DAY);

  if (diffDays === 0) return 'today';
  if (diffDays === 1) return '1 day ago';
  if (diffDays < DAYS_PER_WEEK) return `${diffDays} days ago`;

  const diffWeeks = Math.floor(diffDays / DAYS_PER_WEEK);
  if (diffWeeks === 1) return '1 week ago';
  if (diffWeeks < 4) return `${diffWeeks} weeks ago`;

  const diffMonths = Math.floor(diffDays / DAYS_PER_MONTH);
  if (diffMonths === 1) return '1 month ago';
  return `${diffMonths} months ago`;
}

export function buildMemoryPreview(memories: Memory[]): string | null {
  if (!memories?.length) {
    return null;
  }

  const lines: string[] = [`[PROJECT KNOWLEDGE BASE: ${memories.length} verified entries - CURRENT]`];

  for (const memory of memories) {
    const idShort = memory.id.substring(0, MEMORY_ID_PREFIX_LENGTH);
    const goal = memory.goal || 'No goal';
    const summary = memory.summary || 'No summary';
    const age = formatAge(memory.updated_at);
    lines.push(`#${idShort}: "${goal}" -> ${summary} (${age})`);
  }

  lines.push('Use grov_expand with these IDs to get full knowledge.');

  return lines.join('\n');
}

const PRIORITY_ICONS: Record<string, string> = {
  urgent: '🔴',
  high: '🟠',
};

const STATUS_ICONS: Record<string, string> = {
  completed: '✓',
  in_progress: '→',
  blocked: '⊘',
  pending: '○',
};

export function buildPlanPreview(plans: PlanInjectionContext[]): string | null {
  if (!plans?.length) {
    return null;
  }

  const lines: string[] = ['[TEAM SHARED PLANS - COORDINATE WITH TEAM]'];

  for (const plan of plans) {
    const priorityTag = PRIORITY_ICONS[plan.priority] || '';
    lines.push(`${priorityTag}${plan.title}:`);
    if (plan.content) {
      lines.push(`  ${plan.content}`);
    }

    for (const task of plan.tasks) {
      const isBlocked = task.blocked_by && task.blocked_by.length > 0;
      const statusIcon = isBlocked ? STATUS_ICONS.blocked : (STATUS_ICONS[task.status] || STATUS_ICONS.pending);
      const claimedBy = task.claimed_by_name ? ` (${task.claimed_by_name})` : '';
      const blockedBy = isBlocked ? ` [blocked by: ${task.blocked_by!.join(', ')}]` : '';
      lines.push(`  ${statusIcon} ${task.title}${claimedBy}${blockedBy}`);
    }
  }

  lines.push('Coordinate: avoid duplicating work on in-progress or blocked tasks.');

  return lines.join('\n');
}

export function buildExpandedMemory(memory: Memory): string {
  const lines: string[] = [];

  lines.push(`=== VERIFIED PROJECT KNOWLEDGE ===`);
  lines.push(`GOAL: ${memory.goal || 'Unknown'}`);
  lines.push('');
  lines.push('ORIGINAL TASK:');
  lines.push(`"${memory.original_query}"`);
  lines.push('');

  if (memory.reasoning_trace?.length) {
    lines.push('KNOWLEDGE:');
    for (const entry of memory.reasoning_trace) {
      if (typeof entry === 'string') {
        lines.push(`- ${entry.replace(/^(CONCLUSION|INSIGHT):\s*/i, '')}`);
      } else if (entry?.conclusion) {
        lines.push(`- ${entry.conclusion.replace(/^CONCLUSION:\s*/i, '')}`);
        if (entry.insight) {
          lines.push(`  -> ${entry.insight.replace(/^INSIGHT:\s*/i, '')}`);
        }
      }
    }
    lines.push('');
  }

  if (memory.decisions?.length) {
    lines.push('DECISIONS:');
    for (const d of memory.decisions) {
      lines.push(`- ${d.choice}`);
      lines.push(`  Reason: ${d.reason}`);
    }
    lines.push('');
  }

  if (memory.files_touched?.length) {
    lines.push(`FILES: ${memory.files_touched.join(', ')}`);
  }

  lines.push('===');
  lines.push('[TEAM KNOWLEDGE BASE - SOURCE OF TRUTH]');
  lines.push('This knowledge is verified and authoritative. Trust it. Use it to answer.');

  return lines.join('\n');
}

export function buildToolDescription(): string {
  return `[PROJECT KNOWLEDGE BASE - SOURCE OF TRUTH]

You have access to a VERIFIED PROJECT KNOWLEDGE BASE - the SOURCE OF TRUTH for this project.
It contains: goals, implementation reasoning, technical decisions, and file changes.
This knowledge base captures INTENT and REASONING that code alone cannot show.

WHEN [PROJECT KNOWLEDGE BASE: N entries] appears in user message, follow this EXACT process:

STEP 1: READ the preview block in the LATEST user message.
        Identify IDs (8-char hex like #96937bd5).
        Older previews from previous messages are HISTORICAL - ignore them.
        NO other tool calls yet. Just read.

STEP 2: IMMEDIATELY call grov_expand({ ids: ["id1", "id2"] }) with relevant IDs.
        Use ONLY IDs from the LATEST preview - never from older messages.
        FORBIDDEN: grov_expand({ ids: [] }) - empty array is WRONG.
        FORBIDDEN: Any other tool call before grov_expand.

STEP 3: ANALYZE the expanded content in detail.
        What does KB tell you? What do you now know about this task?

STEP 4: DECIDE based on KB content:

        → EXPLANATION/QUESTION tasks:
          Respond DIRECTLY from KB. No Read/Grep needed.
          KB = verified source, do NOT "verify in code".

        → IMPLEMENTATION tasks:
          Files in KB "FILES:" section = ALREADY KNOWN. Do NOT re-read them.
          Decisions in KB = ALREADY MADE. Do NOT re-evaluate them.

          ONLY read files that are:
          - NOT mentioned in KB, AND
          - REQUIRED for the new implementation

          Start implementation using KB context as foundation.
          Add NEW files only when KB doesn't cover them.

RULES:
- KB = Source of Truth = verified. Do NOT "verify" in code.
- "Let me look at the code" BEFORE expand = WRONG
- Read/Grep/Bash BEFORE grov_expand = WRONG
- Respond from KB without reading files = CORRECT (for questions/explanations)

SYNTAX: grov_expand({ ids: ["abc12345"] }) - IDs from LATEST preview only`;
}

export function buildDriftRecoveryInjection(
  pendingCorrection?: string,
  pendingForcedRecovery?: string
): string | null {
  const parts: string[] = [];
  if (pendingCorrection) parts.push(`[DRIFT: ${pendingCorrection}]`);
  if (pendingForcedRecovery) parts.push(`[RECOVERY: ${pendingForcedRecovery}]`);
  return parts.length ? parts.join('\n') : null;
}

type MessageContent = string | Array<{ type: string; text?: string; [key: string]: unknown }>;

export function appendTextToMessage(
  message: { role: string; content: MessageContent },
  text: string
): void {
  if (typeof message.content === 'string') {
    message.content = message.content + '\n\n' + text;
  } else if (Array.isArray(message.content)) {
    message.content.push({ type: 'text', text: '\n\n' + text });
  }
}

export function reconstructMessages(
  messages: Array<{ role: string; content: unknown }>,
  projectPath: string
): { messages: Array<{ role: string; content: unknown }>; reconstructedCount: number } {
  const state = sessionState.get(projectPath);
  if (!state || state.injectionHistory.length === 0) {
    // No history - just update message count and return
    if (state) state.lastOriginalMsgCount = messages.length;
    return { messages, reconstructedCount: 0 };
  }

  const history = state.injectionHistory;
  const lastCount = state.lastOriginalMsgCount;

  // Detect stale history: if message count DECREASED, it's a new conversation
  // (Claude Code restarted but Grov still running)
  if (messages.length < lastCount - 1) {  // Allow -1 for potential retry
    console.log(`[MEMORY] New conversation detected (was ${lastCount} msgs, now ${messages.length}), clearing history`);
    clearSessionState(projectPath);
    return { messages, reconstructedCount: 0 };
  }

  // Update message count
  state.lastOriginalMsgCount = messages.length;

  const reconstructed = [...messages];
  let insertOffset = 0;
  let count = 0;

  for (const record of history) {
    const adjustedPosition = record.position + insertOffset;

    if (record.type === 'preview' && record.preview) {
      const msg = reconstructed[adjustedPosition];
      if (msg && msg.role === 'user') {
        appendTextToMessage(msg as { role: string; content: MessageContent }, record.preview);
        count++;
      }
    }
    // NOTE: tool_cycle reconstruction disabled - can't fake redacted_thinking for extended thinking
    // Preview reconstruction is sufficient for context
  }

  return { messages: reconstructed, reconstructedCount: count };
}
