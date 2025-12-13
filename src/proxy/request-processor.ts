// Request processor - handles context injection from team memory
// Reference: plan_proxy_local.md Section 2.1

import { type Task, type TaskStatus } from '../lib/store.js';
import { truncate } from '../lib/utils.js';
import { fetchTeamMemories } from '../lib/api-client.js';
import type { Memory } from '@grov/shared';

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
  const startTime = Date.now();
  const hasContext = userPrompt && userPrompt.trim().length > 0;
  console.log(`[CLOUD] ═══════════════════════════════════════════════════════════`);
  console.log(`[CLOUD] buildTeamMemoryContextCloud START`);
  console.log(`[CLOUD] Team: ${teamId.substring(0, 8)}...`);
  console.log(`[CLOUD] Project: ${projectPath}`);
  console.log(`[CLOUD] Prompt: "${hasContext ? userPrompt!.substring(0, 60) + '...' : 'N/A'}"`);
  console.log(`[CLOUD] Files for boost: ${mentionedFiles.length > 0 ? mentionedFiles.join(', ') : 'none'}`);

  try {
    // Fetch memories from cloud API (hybrid search if context provided)
    const fetchStart = Date.now();
    const memories = await fetchTeamMemories(teamId, projectPath, {
      status: 'complete',
      limit: 5, // Max 5 memories for injection (Convex Combination scoring)
      files: mentionedFiles.length > 0 ? mentionedFiles : undefined,
      context: hasContext ? userPrompt : undefined,
      current_files: mentionedFiles.length > 0 ? mentionedFiles : undefined,
    });
    const fetchTime = Date.now() - fetchStart;

    if (memories.length === 0) {
      console.log(`[CLOUD] No memories found (fetch took ${fetchTime}ms)`);
      console.log(`[CLOUD] ═══════════════════════════════════════════════════════════`);
      return null;
    }

    console.log(`[CLOUD] ───────────────────────────────────────────────────────────`);
    console.log(`[CLOUD] Fetched ${memories.length} memories in ${fetchTime}ms`);
    console.log(`[CLOUD] ───────────────────────────────────────────────────────────`);

    // Log each memory with scores (if available from hybrid search)
    for (let i = 0; i < memories.length; i++) {
      const mem = memories[i] as unknown as Record<string, unknown>;
      const semScore = typeof mem.semantic_score === 'number' ? (mem.semantic_score as number).toFixed(3) : '-';
      const lexScore = typeof mem.lexical_score === 'number' ? (mem.lexical_score as number).toFixed(3) : '-';
      const combScore = typeof mem.combined_score === 'number' ? (mem.combined_score as number).toFixed(3) : '-';
      const boosted = mem.file_boost_applied ? '🚀' : '  ';
      const query = String(memories[i].original_query || '').substring(0, 50);
      const filesCount = memories[i].files_touched?.length || 0;
      const reasoningCount = memories[i].reasoning_trace?.length || 0;

      console.log(`[CLOUD] ${i + 1}. ${boosted} [${combScore}] sem=${semScore} lex=${lexScore} | files=${filesCount} reasoning=${reasoningCount}`);
      console.log(`[CLOUD]    "${query}..."`);
    }

    console.log(`[CLOUD] ───────────────────────────────────────────────────────────`);

    // Convert Memory[] to Task[] format for the existing formatter
    const tasks = memories.map(memoryToTask);

    // Reuse existing formatter (no file-level reasoning from cloud yet)
    const context = formatTeamMemoryContext(tasks, [], mentionedFiles);

    // Estimate tokens (~4 chars per token)
    const estimatedTokens = Math.round(context.length / 4);
    const totalTime = Date.now() - startTime;

    console.log(`[CLOUD] Context built: ${context.length} chars (~${estimatedTokens} tokens)`);
    console.log(`[CLOUD] Total time: ${totalTime}ms (fetch: ${fetchTime}ms, format: ${totalTime - fetchTime}ms)`);
    console.log(`[CLOUD] ═══════════════════════════════════════════════════════════`);

    return context;

  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Unknown error';
    console.error(`[CLOUD] buildTeamMemoryContextCloud failed: ${errorMsg}`);
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

      // Inject knowledge pairs (interleaved: conclusion, insight, conclusion, insight...)
      // Take up to 5 pairs (10 entries) per task
      if (task.reasoning_trace.length > 0) {
        lines.push('  Knowledge:');
        const maxPairs = 5;
        const maxEntries = maxPairs * 2; // 10 entries
        const entries = task.reasoning_trace.slice(0, maxEntries);

        for (let i = 0; i < entries.length; i += 2) {
          const conclusion = entries[i];
          const insight = entries[i + 1];

          // Format conclusion (remove prefix for brevity)
          const cText = conclusion?.replace(/^CONCLUSION:\s*/i, '') || '';
          if (cText) {
            lines.push(`    • ${truncate(cText, 120)}`);
          }

          // Format insight (indented under conclusion)
          if (insight) {
            const iText = insight.replace(/^INSIGHT:\s*/i, '');
            lines.push(`      → ${truncate(iText, 100)}`);
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

    // Strip system-reminder tags to get clean user content
    const cleanContent = textContent
      .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
      .trim();

    if (cleanContent) {
      return cleanContent;
    }
  }

  return undefined;
}
