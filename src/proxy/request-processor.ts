// Request processor - handles context injection from team memory
// Reference: plan_proxy_local.md Section 2.1

import { type Task, type TaskStatus } from '../lib/store.js';
import { truncate } from '../lib/utils.js';
import { fetchTeamMemories } from '../lib/api-client.js';
import { isDebugMode } from './utils/logging.js';
import type { Memory } from '@grov/shared';

// Extended memory type with search scores (returned by hybrid search RPC)
interface MemoryWithScores extends Memory {
  semantic_score?: number;
  lexical_score?: number;
  combined_score?: number;
}

/**
 * Build context from CLOUD team memory for injection
 * Fetches memories from Supabase via API (cloud-first approach)
 * Uses hybrid search (semantic + lexical) when userPrompt is provided
 *
 * @param teamId - Team UUID from sync configuration
 * @param projectPath - Project path to filter by
 * @param mentionedFiles - Files mentioned in user messages (for boost)
 * @param userPrompt - User's prompt for semantic search (optional)
 * @returns Formatted context string or null if no memories found
 */
export async function buildTeamMemoryContextCloud(
  teamId: string,
  projectPath: string,
  mentionedFiles: string[],
  userPrompt?: string
): Promise<string | null> {
  const hasContext = userPrompt && userPrompt.trim().length > 0;

  try {
    // Fetch memories from cloud API (hybrid search if context provided)
    const memories = await fetchTeamMemories(teamId, projectPath, {
      status: 'complete',
      limit: 5,
      files: mentionedFiles.length > 0 ? mentionedFiles : undefined,
      context: hasContext ? userPrompt : undefined,
      current_files: mentionedFiles.length > 0 ? mentionedFiles : undefined,
    });

    if (memories.length === 0) {
      return null;
    }

    // Log injected memories (debug mode only)
    if (isDebugMode()) {
      for (const m of memories as MemoryWithScores[]) {
        const label = m.goal || m.original_query;
        const sem = m.semantic_score?.toFixed(2) || '-';
        const lex = m.lexical_score?.toFixed(2) || '-';
        const comb = m.combined_score?.toFixed(2) || '-';
        console.log(`[INJECT] ${label.substring(0, 50)}... (${comb}|${sem}|${lex})`);
      }
    }

    // Convert Memory[] to Task[] format for the existing formatter
    const tasks = memories.map(memoryToTask);

    // Reuse existing formatter
    const context = formatTeamMemoryContext(tasks, [], mentionedFiles);

    return context;

  } catch (err) {
    return null;  // Fail silent - don't block Claude Code
  }
}

/**
 * Convert Memory (cloud format) to Task (local format)
 * Used to reuse existing formatTeamMemoryContext function
 */
function memoryToTask(memory: Memory): Task {
  return {
    id: memory.id,
    project_path: memory.project_path,
    user: memory.user_id || undefined,
    original_query: memory.original_query,
    goal: memory.goal || undefined,
    reasoning_trace: memory.reasoning_trace || [],
    files_touched: memory.files_touched || [],
    decisions: memory.decisions || [],
    constraints: memory.constraints || [],
    status: memory.status as TaskStatus,
    tags: memory.tags || [],
    linked_commit: memory.linked_commit || undefined,
    created_at: memory.created_at,
  };
}

/**
 * Format team memory context for injection
 */
function formatTeamMemoryContext(
  tasks: Task[],
  fileReasonings: Array<{ file_path: string; anchor?: string; reasoning: string }>,
  files: string[]
): string {
  const lines: string[] = [];

  lines.push('=== VERIFIED TEAM KNOWLEDGE (from previous sessions) ===');
  lines.push('');
  lines.push('IMPORTANT: This context has been verified. USE IT to answer directly.');
  lines.push('DO NOT launch Explore agents or re-investigate files mentioned below.');
  lines.push('');

  // File-level context
  if (fileReasonings.length > 0) {
    lines.push('File-level context:');
    for (const fr of fileReasonings.slice(0, 5)) {
      const anchor = fr.anchor ? ` (${fr.anchor})` : '';
      lines.push(`- ${fr.file_path}${anchor}: ${truncate(fr.reasoning, 100)}`);
    }
    lines.push('');
  }

  // Task context with knowledge pairs and decisions
  // Inject up to 5 pairs (10 entries) per task for rich context
  if (tasks.length > 0) {
    lines.push('Related past tasks:');
    for (const task of tasks.slice(0, 5)) { // Limit to 5 tasks (Convex Combination top results)
      lines.push(`- ${truncate(task.original_query, 60)}`);
      if (task.files_touched.length > 0) {
        const fileList = task.files_touched.slice(0, 5).map(f => f.split('/').pop()).join(', ');
        lines.push(`  Files: ${fileList}`);
      }

      // Inject knowledge pairs - handle both formats:
      // Old format: string[] interleaved (conclusion, insight, conclusion, insight...)
      // New format: Array<{ tags?, conclusion, insight? }> objects
      if (task.reasoning_trace.length > 0) {
        lines.push('  Knowledge:');
        const maxPairs = 5;
        const entries = task.reasoning_trace.slice(0, maxPairs);

        for (const entry of entries) {
          if (typeof entry === 'string') {
            // Old format: plain string - just remove prefix and show
            const text = entry.replace(/^(CONCLUSION|INSIGHT):\s*/i, '');
            if (text) {
              lines.push(`    • ${truncate(text, 120)}`);
            }
          } else if (typeof entry === 'object' && entry !== null) {
            // New format: object with tags, conclusion, insight
            const cText = entry.conclusion?.replace(/^CONCLUSION:\s*/i, '') || '';
            if (cText) {
              const prefix = entry.tags ? `[${entry.tags}] ` : '';
              lines.push(`    • ${prefix}${truncate(cText, 110)}`);
            }
            if (entry.insight) {
              const iText = entry.insight.replace(/^INSIGHT:\s*/i, '');
              lines.push(`      → ${truncate(iText, 100)}`);
            }
          }
        }
      }

      // Include decisions (up to 2 per task)
      if (task.decisions && task.decisions.length > 0) {
        const decisionsToShow = task.decisions.slice(0, 2);
        for (const decision of decisionsToShow) {
          lines.push(`  Decision: ${truncate(decision.choice, 60)} (${truncate(decision.reason, 50)})`);
        }
      }

      // Include constraints if available
      if (task.constraints && task.constraints.length > 0) {
        lines.push(`  Constraints: ${task.constraints.slice(0, 2).join(', ')}`);
      }
    }
    lines.push('');
  }

  if (files.length > 0) {
    lines.push(`Files with existing context: ${files.join(', ')}`);
  }
  lines.push('');
  lines.push('Answer the user\'s question using the knowledge above. Skip exploration.');
  lines.push('=== END VERIFIED TEAM KNOWLEDGE ===');

  return lines.join('\n');
}

/**
 * Extract file paths from messages (user messages only, clean text)
 */
export function extractFilesFromMessages(
  messages: Array<{ role: string; content: unknown }>
): string[] {
  const files: string[] = [];
  // Pattern matches filenames with extensions, allowing common punctuation after
  const filePattern = /(?:^|\s|["'`])([\/\w.-]+\.[a-zA-Z]{1,10})(?:["'`]|\s|$|[:)\]?!,;])/g;

  for (const msg of messages) {
    // Only scan user messages for file mentions
    if (msg.role !== 'user') continue;

    let textContent = '';

    // Handle string content
    if (typeof msg.content === 'string') {
      textContent = msg.content;
    }

    // Handle array content (Claude Code API format)
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block && typeof block === 'object' && 'type' in block && block.type === 'text' && 'text' in block && typeof block.text === 'string') {
          textContent += block.text + '\n';
        }
      }
    }

    // Strip system-reminder tags to get clean user content
    const cleanContent = textContent
      .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
      .trim();

    if (cleanContent) {
      let match;
      while ((match = filePattern.exec(cleanContent)) !== null) {
        const path = match[1];
        // Filter out common false positives
        if (!path.includes('http') && !path.startsWith('.') && path.length > 3) {
          files.push(path);
        }
      }
    }
  }

  return [...new Set(files)];
}

/**
 * Extract the last user prompt from messages for semantic search
 * Returns clean text without system tags
 */
export function extractLastUserPrompt(
  messages: Array<{ role: string; content: unknown }>
): string | undefined {
  // Find last user message
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'user') continue;

    let textContent = '';

    // Handle string content
    if (typeof msg.content === 'string') {
      textContent = msg.content;
    }

    // Handle array content (Claude Code API format)
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block && typeof block === 'object' && 'type' in block && block.type === 'text' && 'text' in block && typeof block.text === 'string') {
          textContent += block.text + '\n';
        }
      }
    }

    // Strip system-reminder tags and continuation artifacts to get clean user content
    const cleanContent = textContent
      // Remove actual system-reminder tags
      .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
      // Remove escaped/broken system-reminder artifacts from continuation summaries
      .replace(/\\n["']?\s*<\/system-reminder>/g, '')
      .replace(/<\/system-reminder>/g, '')
      // Remove continuation summary header if it's the entire content
      .replace(/^This session is being continued from a previous conversation[\s\S]*?Summary:/gi, '')
      // Clean up leading noise (newlines, quotes, whitespace)
      .replace(/^[\s\n"'\\]+/, '')
      .trim();

    if (cleanContent && cleanContent.length > 5) {
      return cleanContent;
    }
  }

  return undefined;
}
