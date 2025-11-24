// grov capture - Called by Stop hook, extracts and stores reasoning

import { findLatestSessionFile, parseSession, getSessionSummary } from '../lib/jsonl-parser.js';
import { createTask, type TaskStatus } from '../lib/store.js';

interface CaptureOptions {
  sessionDir?: string;
}

export async function capture(options: CaptureOptions): Promise<void> {
  // Get current working directory as project path
  const projectPath = process.cwd();

  // Find the latest session file
  const sessionFile = findLatestSessionFile(projectPath);

  if (!sessionFile) {
    // No session file found - this is normal for new projects
    // Silent exit - don't spam the user
    return;
  }

  try {
    // Parse the session
    const session = parseSession(sessionFile);

    // Skip if no user messages (empty session)
    if (session.userMessages.length === 0) {
      return;
    }

    // Get the original query (first user message)
    const originalQuery = session.userMessages[0];

    // Combine all files touched
    const filesTouched = [...new Set([...session.filesRead, ...session.filesWritten])];

    // Simple status classification (will be replaced by LLM in Step 6)
    // For now, assume complete if there are file writes
    const status: TaskStatus = session.filesWritten.length > 0 ? 'complete' : 'partial';

    // Generate simple tags from file paths
    const tags = generateTags(filesTouched);

    // Create basic reasoning trace from tool usage
    const reasoningTrace = generateBasicReasoningTrace(session);

    // Store the task
    const task = createTask({
      project_path: projectPath,
      original_query: originalQuery,
      goal: originalQuery, // Same as query for now
      reasoning_trace: reasoningTrace,
      files_touched: filesTouched,
      status,
      tags
    });

    // Log for debugging (can be removed later)
    if (process.env.GROV_DEBUG) {
      console.error(`[grov] Captured task: ${task.id}`);
      console.error(`[grov] Query: ${originalQuery.substring(0, 50)}...`);
      console.error(`[grov] Files: ${filesTouched.length}`);
      console.error(`[grov] Status: ${status}`);
    }

  } catch (error) {
    // Silent fail - don't interrupt user's workflow
    if (process.env.GROV_DEBUG) {
      console.error('[grov] Capture error:', error);
    }
  }
}

/**
 * Generate tags from file paths
 */
function generateTags(files: string[]): string[] {
  const tags = new Set<string>();

  for (const file of files) {
    const parts = file.split('/');
    const filename = parts[parts.length - 1];

    // Add directory names as tags
    for (const part of parts) {
      if (part && !part.includes('.') && part !== 'src' && part !== 'lib') {
        tags.add(part.toLowerCase());
      }
    }

    // Add file extension as tag
    const ext = filename.split('.').pop();
    if (ext && ext !== filename) {
      tags.add(ext);
    }

    // Common patterns
    if (filename.includes('auth')) tags.add('auth');
    if (filename.includes('api')) tags.add('api');
    if (filename.includes('test')) tags.add('test');
    if (filename.includes('config')) tags.add('config');
    if (filename.includes('route')) tags.add('routes');
    if (filename.includes('model')) tags.add('models');
    if (filename.includes('util')) tags.add('utils');
  }

  return [...tags].slice(0, 10); // Limit to 10 tags
}

/**
 * Generate basic reasoning trace from session data
 */
function generateBasicReasoningTrace(session: ReturnType<typeof parseSession>): string[] {
  const trace: string[] = [];

  // Count tool usage
  const toolCounts = session.toolCalls.reduce((acc, t) => {
    acc[t.name] = (acc[t.name] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  // Add tool usage summary
  if (toolCounts['Read']) {
    trace.push(`Read ${toolCounts['Read']} files`);
  }
  if (toolCounts['Write']) {
    trace.push(`Wrote ${toolCounts['Write']} files`);
  }
  if (toolCounts['Edit']) {
    trace.push(`Edited ${toolCounts['Edit']} files`);
  }
  if (toolCounts['Grep'] || toolCounts['Glob']) {
    trace.push(`Searched codebase`);
  }
  if (toolCounts['Bash']) {
    trace.push(`Ran ${toolCounts['Bash']} commands`);
  }

  // Add file summaries
  if (session.filesRead.length > 0) {
    trace.push(`Files examined: ${session.filesRead.slice(0, 5).map(f => f.split('/').pop()).join(', ')}`);
  }
  if (session.filesWritten.length > 0) {
    trace.push(`Files modified: ${session.filesWritten.map(f => f.split('/').pop()).join(', ')}`);
  }

  return trace;
}
