// Request processor - handles context injection from team memory
// Reference: plan_proxy_local.md Section 2.1

import {
  getTasksForProject,
  getTasksByFiles,
  getStepsReasoningByPath,
  type Task,
} from '../lib/store.js';
import { truncate } from '../lib/utils.js';

/**
 * Build context from team memory for injection (PAST sessions only)
 * Queries tasks and file_reasoning tables, excluding current session data
 * @param currentSessionId - Session ID to exclude (ensures only past session data)
 */
export function buildTeamMemoryContext(
  projectPath: string,
  mentionedFiles: string[],
  currentSessionId?: string
): string | null {
  // Get recent completed tasks for this project
  const tasks = getTasksForProject(projectPath, {
    status: 'complete',
    limit: 10,
  });

  // Get tasks that touched mentioned files
  const fileTasks = mentionedFiles.length > 0
    ? getTasksByFiles(projectPath, mentionedFiles, { status: 'complete', limit: 5 })
    : [];

  // Get file-level reasoning from steps table (PAST sessions only)
  // Pass currentSessionId to exclude current session data
  const fileReasonings = mentionedFiles.length > 0
    ? mentionedFiles.flatMap(f => getStepsReasoningByPath(f, 3, currentSessionId))
    : [];

  // Combine unique tasks
  const allTasks = [...new Map([...tasks, ...fileTasks].map(t => [t.id, t])).values()];

  if (allTasks.length === 0 && fileReasonings.length === 0) {
    return null;
  }

  return formatTeamMemoryContext(allTasks, fileReasonings, mentionedFiles);
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

  // Task context with decisions and constraints
  if (tasks.length > 0) {
    lines.push('Related past tasks:');
    for (const task of tasks.slice(0, 5)) {
      lines.push(`- ${truncate(task.original_query, 60)}`);
      if (task.files_touched.length > 0) {
        const fileList = task.files_touched.slice(0, 3).map(f => f.split('/').pop()).join(', ');
        lines.push(`  Files: ${fileList}`);
      }
      if (task.reasoning_trace.length > 0) {
        lines.push(`  Key: ${truncate(task.reasoning_trace[0], 80)}`);
      }
      // Include decisions if available
      if (task.decisions && task.decisions.length > 0) {
        lines.push(`  Decision: ${task.decisions[0].choice} (${truncate(task.decisions[0].reason, 50)})`);
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
