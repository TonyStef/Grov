// Memory injection - Preview + Expand system for team memory
// Reference: docs/new_injection.md

import type { Memory } from '@grov/shared';

export interface InjectionRecord {
  position: number;
  type: 'preview' | 'tool_cycle';
  preview?: string;
  toolUse?: { id: string; name: string; input: unknown };
  toolResult?: string;
}

export interface SessionInjectionState {
  memories: Memory[];
  injectionHistory: InjectionRecord[];
  lastOriginalMsgCount: number;  // Track original message count for stale detection
}

const sessionState = new Map<string, SessionInjectionState>();

export function getOrCreateState(sessionId: string): SessionInjectionState {
  if (!sessionState.has(sessionId)) {
    sessionState.set(sessionId, {
      memories: [],
      injectionHistory: [],
      lastOriginalMsgCount: 0,
    });
  }
  return sessionState.get(sessionId)!;
}

export function clearSessionState(sessionId: string): void {
  sessionState.delete(sessionId);
}

export function cacheMemories(sessionId: string, memories: Memory[]): void {
  const state = getOrCreateState(sessionId);
  state.memories = memories;
}

export function getCachedMemory(sessionId: string, index: number): Memory | null {
  const state = sessionState.get(sessionId);
  if (!state?.memories) return null;
  return state.memories[index - 1] || null;
}

export function getCachedMemories(sessionId: string): Memory[] {
  return sessionState.get(sessionId)?.memories || [];
}

export function addInjectionRecord(sessionId: string, record: InjectionRecord): void {
  const state = getOrCreateState(sessionId);
  state.injectionHistory.push(record);
}

export function getInjectionHistory(sessionId: string): InjectionRecord[] {
  return sessionState.get(sessionId)?.injectionHistory || [];
}

export function formatAge(updatedAt: string | undefined): string {
  if (!updatedAt) return 'unknown';

  const diffMs = Date.now() - new Date(updatedAt).getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return 'today';
  if (diffDays === 1) return '1 day ago';
  if (diffDays < 7) return `${diffDays} days ago`;

  const diffWeeks = Math.floor(diffDays / 7);
  if (diffWeeks === 1) return '1 week ago';
  if (diffWeeks < 4) return `${diffWeeks} weeks ago`;

  const diffMonths = Math.floor(diffDays / 30);
  if (diffMonths === 1) return '1 month ago';
  return `${diffMonths} months ago`;
}

export function buildMemoryPreview(memories: Memory[]): string | null {
  if (!memories || memories.length === 0) return null;

  const lines: string[] = [`[PROJECT KNOWLEDGE BASE: ${memories.length} verified entries]`];

  memories.forEach((memory, index) => {
    const goal = memory.goal || 'No goal';
    const summary = memory.summary || 'No summary';
    const age = formatAge(memory.updated_at);
    lines.push(`#${index + 1}: "${goal}" -> ${summary} (${age})`);
    lines.push('    Source of truth: goals, reasoning, decisions, files - use grov_expand');
  });

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

  return lines.join('\n');
}

export function buildToolDescription(): string {
  return `[PROJECT KNOWLEDGE BASE - SOURCE OF TRUTH]

You have access to a VERIFIED PROJECT KNOWLEDGE BASE containing authoritative information:
goals, implementation reasoning, technical decisions, and file changes.

This is the SOURCE OF TRUTH for what was done and why. It is MORE reliable than reading
files because it captures INTENT and REASONING that code alone cannot show.

WHEN [PROJECT KNOWLEDGE BASE: N verified entries] appears, follow this process:

STEP 1: Check if any entries are relevant to the user's question.

STEP 2: For relevant entries, use grov_expand to get full verified knowledge.
        DO NOT read files first - the knowledge base has authoritative context.

STEP 3: After expanding, you have: goal, original task, reasoning, decisions, files.
        For EXPLANATION tasks ("what did I do?", "why?", "explain") → ANSWER DIRECTLY.
        The knowledge base IS the answer. Do not verify with files.

STEP 4: Only read files if:
        - User asks to MODIFY code (need current state)
        - Knowledge base explicitly says information is outdated
        - User explicitly asks to see actual code

USE:
grov_expand({ indices: [1] })      - get full knowledge for entry #1
grov_expand({ indices: [1, 2] })   - get multiple entries

The knowledge base contains verified decisions and reasoning. Trust it.`;
}

export function buildToolDefinition(): object {
  return {
    name: 'grov_expand',
    description: 'Get verified project knowledge. Returns authoritative goal, reasoning, decisions, and context. Use this as source of truth for explanation tasks.',
    input_schema: {
      type: 'object',
      properties: {
        indices: {
          type: 'array',
          items: { type: 'number' },
          description: 'Which memories to expand (1-based index from preview)',
        },
      },
      required: ['indices'],
    },
  };
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
    } else if (record.type === 'tool_cycle' && record.toolUse && record.toolResult) {
      // Insert assistant message with tool_use after the position
      const assistantMsg = {
        role: 'assistant',
        content: [{ type: 'tool_use', id: record.toolUse.id, name: record.toolUse.name, input: record.toolUse.input }],
      };
      const toolResultMsg = {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: record.toolUse.id, content: record.toolResult }],
      };

      reconstructed.splice(adjustedPosition + 1, 0, assistantMsg, toolResultMsg);
      insertOffset += 2;
      count++;
    }
  }

  if (count > 0) {
    console.log(`[MEMORY] Reconstructed ${count} injection(s) for cache consistency`);
  }

  return { messages: reconstructed, reconstructedCount: count };
}
