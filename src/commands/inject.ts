// grov inject - Called by SessionStart hook, outputs context JSON

import { getTasksForProject, type Task } from '../lib/store.js';
import { appendFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

interface InjectOptions {
  task?: string;
}

export async function inject(options: InjectOptions): Promise<void> {
  // Debug logging to file (to verify hook fires)
  const logFile = join(homedir(), '.grov', 'inject.log');
  const timestamp = new Date().toISOString();
  const projectDir = process.env.CLAUDE_PROJECT_DIR || 'NOT_SET';
  const cwd = process.cwd();
  appendFileSync(logFile, `[${timestamp}] inject called - CLAUDE_PROJECT_DIR=${projectDir}, cwd=${cwd}\n`);

  try {
    // Get project path from Claude Code env var, fallback to cwd
    // CLAUDE_PROJECT_DIR is set by Claude Code when running hooks
    const projectPath = process.env.CLAUDE_PROJECT_DIR || process.cwd();

    // Get completed tasks for this project
    const tasks = getTasksForProject(projectPath, {
      status: 'complete',
      limit: 5 // Only inject most recent 5
    });

    // Build context string
    const context = buildContextString(tasks);

    // Only output if we have context to inject
    // Claude Code expects JSON with hookEventName for SessionStart hooks
    if (context) {
      const output = {
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: context
        }
      };
      console.log(JSON.stringify(output));
    }
    // If no context, output nothing - this is cleaner for Claude Code

  } catch (error) {
    // On error, output nothing - don't break the session
    // Silent fail is better than outputting potentially invalid JSON
    if (process.env.GROV_DEBUG) {
      console.error('[grov] Inject error:', error);
    }
  }
}

/**
 * Build the context string to inject
 */
function buildContextString(tasks: Task[]): string {
  if (tasks.length === 0) {
    return ''; // No context to inject
  }

  const lines: string[] = [];

  lines.push('VERIFIED CONTEXT FROM PREVIOUS SESSIONS:');
  lines.push('(This context was captured from your previous work on this codebase)');
  lines.push('');

  for (const task of tasks) {
    lines.push(`[Task: ${truncate(task.original_query, 80)}]`);

    // Files touched
    if (task.files_touched.length > 0) {
      const fileList = task.files_touched
        .slice(0, 5)
        .map(f => f.split('/').pop())
        .join(', ');
      lines.push(`- Files: ${fileList}${task.files_touched.length > 5 ? ` (+${task.files_touched.length - 5} more)` : ''}`);
    }

    // Reasoning trace
    if (task.reasoning_trace.length > 0) {
      for (const trace of task.reasoning_trace.slice(0, 3)) {
        lines.push(`- ${trace}`);
      }
    }

    // Tags
    if (task.tags.length > 0) {
      lines.push(`- Tags: ${task.tags.join(', ')}`);
    }

    lines.push('');
  }

  // Add instruction for Claude
  lines.push('YOU MAY SKIP EXPLORE AGENTS for files mentioned above.');
  lines.push('Read them directly if relevant to the current task.');

  return lines.join('\n');
}

/**
 * Truncate string to max length
 */
function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return str.substring(0, maxLength - 3) + '...';
}
