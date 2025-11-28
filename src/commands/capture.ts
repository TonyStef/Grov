// grov capture - Called by Stop hook, extracts and stores reasoning

import { findLatestSessionFile, parseSession, getSessionIdFromPath } from '../lib/jsonl-parser.js';
import {
  createTask,
  createFileReasoning,
  getSessionState,
  updateSessionState,
  type TaskStatus
} from '../lib/store.js';
import { isLLMAvailable, extractReasoning } from '../lib/llm-extractor.js';
import {
  extractAnchors,
  findAnchorAtLine,
  computeCodeHash,
  estimateLineNumber,
  type AnchorInfo
} from '../lib/anchor-extractor.js';
import { debugCapture } from '../lib/debug.js';
import { truncate, capitalize } from '../lib/utils.js';
import { readFileSync, existsSync } from 'fs';

interface CaptureOptions {
  sessionDir?: string;
}

export async function capture(options: CaptureOptions): Promise<void> {
  // Get project path from Claude Code env var, fallback to cwd
  // CLAUDE_PROJECT_DIR is set by Claude Code when running hooks
  const projectPath = process.env.CLAUDE_PROJECT_DIR || process.cwd();

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

    let goal: string;
    let reasoningTrace: string[];
    let filesTouched: string[];
    let status: TaskStatus;
    let tags: string[];

    // Use LLM extraction if available, otherwise fall back to basic extraction
    if (isLLMAvailable()) {
      try {
        debugCapture('Using LLM extraction...');

        const extracted = await extractReasoning(session);

        goal = extracted.goal;
        reasoningTrace = extracted.reasoning_trace;
        filesTouched = extracted.files_touched;
        status = extracted.status;
        tags = extracted.tags;

        debugCapture('LLM extraction complete: status=%s', status);
      } catch (llmError) {
        debugCapture('LLM extraction failed, using fallback: %O', llmError);
        // Fall back to basic extraction
        const basic = basicExtraction(session);
        goal = basic.goal;
        reasoningTrace = basic.reasoningTrace;
        filesTouched = basic.filesTouched;
        status = basic.status;
        tags = basic.tags;
      }
    } else {
      // No API key - use basic extraction
      const basic = basicExtraction(session);
      goal = basic.goal;
      reasoningTrace = basic.reasoningTrace;
      filesTouched = basic.filesTouched;
      status = basic.status;
      tags = basic.tags;
    }

    // Store the task
    const task = createTask({
      project_path: projectPath,
      original_query: originalQuery,
      goal,
      reasoning_trace: reasoningTrace,
      files_touched: filesTouched,
      status,
      tags
    });

    // Create file_reasoning entries for each file touched
    await createFileReasoningEntries(task.id, session, goal);

    // Update session state if exists
    const sessionId = getSessionIdFromPath(sessionFile);
    if (sessionId) {
      const sessionState = getSessionState(sessionId);
      if (sessionState) {
        updateSessionState(sessionId, {
          status: status === 'complete' ? 'completed' : 'abandoned',
          files_explored: [...new Set([...sessionState.files_explored, ...filesTouched])],
          original_goal: goal,
        });
        debugCapture('Updated session state: %s', sessionId);
      }
    }

    // Log for debugging
    debugCapture('Captured task: %s', task.id);
    debugCapture('Query: %s...', originalQuery.substring(0, 50));
    debugCapture('Files: %d', filesTouched.length);
    debugCapture('Status: %s', status);
    debugCapture('LLM: %s', isLLMAvailable() ? 'yes' : 'no');

  } catch (error) {
    // Silent fail - don't interrupt user's workflow
    debugCapture('Capture error: %O', error);
  }
}

/**
 * Basic extraction without LLM
 */
function basicExtraction(session: ReturnType<typeof parseSession>) {
  const filesTouched = [...new Set([...session.filesRead, ...session.filesWritten])];
  const status: TaskStatus = session.filesWritten.length > 0 ? 'complete' : 'partial';

  return {
    goal: session.userMessages[0] || 'Unknown goal',
    reasoningTrace: generateBasicReasoningTrace(session),
    filesTouched,
    status,
    tags: generateTags(filesTouched)
  };
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

/**
 * Create file_reasoning entries for each file touched in the session
 */
async function createFileReasoningEntries(
  taskId: string,
  session: ReturnType<typeof parseSession>,
  goal: string
): Promise<void> {
  try {
    // Process files that were written/edited
    for (const filePath of session.filesWritten) {
      await createFileReasoningForFile(taskId, filePath, session, goal, true);
    }

    // Also process files that were only read (with less detail)
    for (const filePath of session.filesRead) {
      // Skip if already processed as written
      if (session.filesWritten.includes(filePath)) continue;
      await createFileReasoningForFile(taskId, filePath, session, goal, false);
    }
  } catch (error) {
    debugCapture('Error creating file reasoning entries: %O', error);
  }
}

/**
 * Create a file_reasoning entry for a specific file
 */
async function createFileReasoningForFile(
  taskId: string,
  filePath: string,
  session: ReturnType<typeof parseSession>,
  goal: string,
  wasModified: boolean
): Promise<void> {
  try {
    // Check if file exists
    if (!existsSync(filePath)) {
      return;
    }

    // Read file content
    const content = readFileSync(filePath, 'utf-8');

    // Extract anchors from the file
    const anchors = extractAnchors(filePath, content);

    // Find the Edit tool call for this file to determine what was changed
    const editCalls = session.toolCalls.filter(
      t => t.name === 'Edit' && (t.input as { file_path?: string })?.file_path === filePath
    );

    if (editCalls.length > 0 && wasModified) {
      // For each edit, try to find the anchor
      for (const editCall of editCalls) {
        const input = editCall.input as { old_string?: string; new_string?: string };
        if (input.old_string) {
          const lineNumber = estimateLineNumber(input.old_string, content);
          const anchor = lineNumber ? findAnchorAtLine(anchors, lineNumber) : null;

          const lineStart = anchor?.lineStart || lineNumber || undefined;
          const lineEnd = anchor?.lineEnd || lineNumber || undefined;

          createFileReasoning({
            task_id: taskId,
            file_path: filePath,
            anchor: anchor?.name,
            line_start: lineStart,
            line_end: lineEnd,
            code_hash: lineStart && lineEnd ? computeCodeHash(content, lineStart, lineEnd) : undefined,
            change_type: 'edit',
            reasoning: buildReasoningString(anchor, goal, 'edited')
          });
        }
      }
    } else if (wasModified) {
      // File was created/written without Edit
      const writeCalls = session.toolCalls.filter(
        t => t.name === 'Write' && (t.input as { file_path?: string })?.file_path === filePath
      );

      const changeType = writeCalls.length > 0 ? 'create' : 'write';

      createFileReasoning({
        task_id: taskId,
        file_path: filePath,
        anchor: anchors.length > 0 ? anchors[0].name : undefined,
        line_start: 1,
        line_end: content.split('\n').length,
        code_hash: computeCodeHash(content, 1, content.split('\n').length),
        change_type: changeType,
        reasoning: buildReasoningString(null, goal, changeType === 'create' ? 'created' : 'wrote')
      });
    } else {
      // File was only read
      createFileReasoning({
        task_id: taskId,
        file_path: filePath,
        anchor: anchors.length > 0 ? anchors[0].name : undefined,
        change_type: 'read',
        reasoning: `Read during: ${truncate(goal, 80)}`
      });
    }
  } catch (error) {
    debugCapture('Error processing file %s: %O', filePath, error);
  }
}

/**
 * Build a reasoning string for a file modification
 */
function buildReasoningString(anchor: AnchorInfo | null, goal: string, action: string): string {
  const shortGoal = truncate(goal, 80);
  if (anchor) {
    return `${capitalize(action)} ${anchor.type} "${anchor.name}": ${shortGoal}`;
  }
  return `${capitalize(action)} file: ${shortGoal}`;
}
