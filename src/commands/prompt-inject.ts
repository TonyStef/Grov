// grov prompt-inject - Called by UserPromptSubmit hook, outputs context JSON
// This provides continuous context injection on every user prompt

import {
  getTasksForProject,
  getTasksByFiles,
  getFileReasoningByPathPattern,
  type Task,
} from '../lib/store.js';
import { debugInject } from '../lib/debug.js';
import { truncate } from '../lib/utils.js';

// Maximum stdin size to prevent memory exhaustion (1MB)
const MAX_STDIN_SIZE = 1024 * 1024;

// Input format from UserPromptSubmit hook (via stdin)
interface PromptInput {
  prompt: string;
  session_id?: string;
  cwd: string;
}

// Simple prompts that don't need context injection
const SIMPLE_PROMPTS = [
  'yes', 'no', 'ok', 'okay', 'continue', 'go ahead',
  'sure', 'yep', 'nope', 'y', 'n', 'proceed', 'do it',
  'looks good', 'that works', 'perfect', 'thanks', 'thank you',
  'next', 'done', 'good', 'great', 'fine', 'correct',
  'right', 'exactly', 'agreed', 'approve', 'confirm'
];

// Stop words to filter out when extracting keywords
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been',
  'to', 'for', 'and', 'or', 'in', 'on', 'at', 'of', 'with',
  'this', 'that', 'these', 'those', 'it', 'its', 'i', 'you',
  'we', 'they', 'my', 'your', 'our', 'their', 'can', 'could',
  'would', 'should', 'will', 'do', 'does', 'did', 'have', 'has',
  'had', 'not', 'but', 'if', 'then', 'else', 'when', 'where',
  'how', 'what', 'why', 'which', 'who', 'all', 'each', 'every',
  'some', 'any', 'no', 'from', 'by', 'as', 'so', 'too', 'also',
  'just', 'only', 'now', 'here', 'there', 'please', 'help', 'me',
  'make', 'get', 'add', 'fix', 'update', 'change', 'modify', 'create'
]);

export interface PromptInjectOptions {
  // Currently no options needed
}

export async function promptInject(_options: PromptInjectOptions): Promise<void> {
  try {
    // Read input from stdin
    const input = await readStdinInput();

    if (!input || !input.prompt) {
      return; // No prompt, no injection
    }

    // Skip simple prompts to save tokens
    if (isSimplePrompt(input.prompt)) {
      return; // No output = no injection
    }

    const projectPath = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();

    // Get recent completed tasks for this project
    const tasks = getTasksForProject(projectPath, {
      status: 'complete',
      limit: 20
    });

    if (tasks.length === 0) {
      return; // No past context to inject
    }

    // Find relevant tasks via file paths and keywords
    const explicitFiles = extractFilePaths(input.prompt);
    const fileTasks = explicitFiles.length > 0
      ? getTasksByFiles(projectPath, explicitFiles, { status: 'complete', limit: 10 })
      : [];

    const keywordTasks = findKeywordMatches(input.prompt, tasks);

    // Also get file-level reasoning for mentioned files
    const fileReasonings = explicitFiles.length > 0
      ? explicitFiles.flatMap(f => getFileReasoningByPathPattern(f, 5))
      : [];

    // Combine and deduplicate tasks
    const relevantTasks = dedupeAndLimit([...fileTasks, ...keywordTasks], 5);

    // Should we inject? Need at least some relevant context
    if (relevantTasks.length === 0 && fileReasonings.length === 0) {
      return; // No output = no injection
    }

    // Build and output context
    const context = buildPromptContext(relevantTasks, explicitFiles, fileReasonings);

    if (context) {
      const output = {
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: context
        }
      };
      console.log(JSON.stringify(output));
    }

  } catch (error) {
    // Silent fail - don't break user workflow
    debugInject('prompt-inject error: %O', error);
  }
}

/**
 * Read JSON input from stdin with timeout and size limit.
 * SECURITY: Limits input size to prevent memory exhaustion attacks.
 * OPTIMIZED: Uses array + join instead of O(n²) string concatenation.
 */
async function readStdinInput(): Promise<PromptInput | null> {
  return new Promise((resolve) => {
    // Set a timeout to prevent hanging
    const timeout = setTimeout(() => {
      debugInject('stdin timeout reached');
      resolve(null);
    }, 3000); // 3 second timeout

    const chunks: string[] = [];
    let totalLength = 0;
    let sizeLimitExceeded = false;

    process.stdin.setEncoding('utf-8');

    process.stdin.on('readable', () => {
      let chunk;
      while ((chunk = process.stdin.read()) !== null) {
        totalLength += chunk.length;
        // SECURITY: Check size limit
        if (totalLength > MAX_STDIN_SIZE) {
          sizeLimitExceeded = true;
          clearTimeout(timeout);
          debugInject('stdin size limit exceeded');
          resolve(null);
          return;
        }
        chunks.push(chunk);
      }
    });

    process.stdin.on('end', () => {
      clearTimeout(timeout);
      if (sizeLimitExceeded) return;

      try {
        const data = chunks.join('');
        const parsed = JSON.parse(data.trim()) as unknown;

        // Validate required fields
        if (!parsed || typeof parsed !== 'object') {
          debugInject('Invalid stdin input: not an object');
          resolve(null);
          return;
        }

        const input = parsed as Record<string, unknown>;
        if (typeof input.prompt !== 'string' || typeof input.cwd !== 'string') {
          debugInject('Invalid stdin input: missing required fields');
          resolve(null);
          return;
        }

        resolve(input as unknown as PromptInput);
      } catch {
        debugInject('Failed to parse stdin JSON');
        resolve(null);
      }
    });

    process.stdin.on('error', () => {
      clearTimeout(timeout);
      debugInject('stdin error');
      resolve(null);
    });
  });
}

/**
 * Check if a prompt is simple and doesn't need context injection
 */
function isSimplePrompt(prompt: string): boolean {
  const normalized = prompt.trim().toLowerCase();

  // Very short prompts are likely simple
  if (normalized.length < 3) return true;

  // Check against simple prompt list
  for (const simple of SIMPLE_PROMPTS) {
    if (normalized === simple ||
        normalized.startsWith(simple + ' ') ||
        normalized.startsWith(simple + ',') ||
        normalized.startsWith(simple + '.')) {
      return true;
    }
  }

  // If the prompt is very short and doesn't contain code-related words
  if (normalized.length < 20 && !normalized.match(/\.(ts|js|py|go|rs|java|tsx|jsx)/)) {
    // Check if it's just a simple acknowledgment
    const words = normalized.split(/\s+/);
    if (words.length <= 3) {
      return true;
    }
  }

  return false;
}

/**
 * Extract file paths from a prompt.
 * SECURITY: Uses simplified patterns to avoid ReDoS with pathological input.
 */
function extractFilePaths(prompt: string): string[] {
  // SECURITY: Limit input length to prevent ReDoS
  const safePrompt = prompt.length > 10000 ? prompt.substring(0, 10000) : prompt;

  const files = new Set<string>();

  // Split by whitespace and common delimiters for simpler, safer matching
  const tokens = safePrompt.split(/[\s,;:'"``]+/);

  for (const token of tokens) {
    // Skip empty tokens and URLs
    if (!token || token.match(/^https?:\/\//i)) continue;

    // Match file-like patterns: must have extension
    if (token.match(/^[.\/]?[\w\-\/]+\.\w{1,5}$/)) {
      // Filter out version numbers like 1.0.0
      if (!token.match(/^\d+\.\d+/)) {
        files.add(token);
      }
    }
  }

  return [...files];
}

/**
 * Extract keywords from a prompt for matching against tasks
 */
function extractKeywords(prompt: string): string[] {
  const words = prompt.toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));

  return [...new Set(words)];
}

/**
 * Find tasks that match keywords from the prompt.
 * OPTIMIZED: O(n) instead of O(n²) - builds keyword set once.
 */
function findKeywordMatches(prompt: string, tasks: Task[]): Task[] {
  const keywords = extractKeywords(prompt);

  if (keywords.length === 0) {
    return [];
  }

  // Build keyword set for O(1) lookups
  const keywordSet = new Set(keywords);

  return tasks.filter(task => {
    // Match against task tags - O(tags) lookup
    const tagMatch = task.tags.some(tag => {
      const lowerTag = tag.toLowerCase();
      return keywordSet.has(lowerTag) ||
        keywords.some(kw => lowerTag.includes(kw) || kw.includes(lowerTag));
    });
    if (tagMatch) return true;

    // Match against goal - extract once per task
    const goalWords = (task.goal || '').toLowerCase().split(/\s+/).filter(w => w.length > 2);
    const goalMatch = goalWords.some(gw => keywordSet.has(gw));
    if (goalMatch) return true;

    // Match against original query - extract once per task
    const queryWords = task.original_query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    const queryMatch = queryWords.some(qw => keywordSet.has(qw));

    return queryMatch;
  });
}

/**
 * Deduplicate tasks by ID and limit count
 */
function dedupeAndLimit(tasks: Task[], limit: number): Task[] {
  const seen = new Set<string>();
  const unique: Task[] = [];

  for (const task of tasks) {
    if (!seen.has(task.id)) {
      seen.add(task.id);
      unique.push(task);
      if (unique.length >= limit) break;
    }
  }

  return unique;
}

/**
 * Build context string for prompt injection
 */
function buildPromptContext(
  tasks: Task[],
  files: string[],
  fileReasonings: { file_path: string; anchor?: string; reasoning: string }[]
): string {
  const lines: string[] = [];

  lines.push('[GROV CONTEXT - Relevant past reasoning]');
  lines.push('');

  // Add file-specific reasoning if available
  if (fileReasonings.length > 0) {
    lines.push('File-level context:');
    for (const fr of fileReasonings.slice(0, 5)) {
      const anchor = fr.anchor ? ` (${fr.anchor})` : '';
      lines.push(`- ${fr.file_path}${anchor}: ${truncate(fr.reasoning, 100)}`);
    }
    lines.push('');
  }

  // Add task context
  if (tasks.length > 0) {
    lines.push('Related past tasks:');
    for (const task of tasks) {
      lines.push(`- ${truncate(task.original_query, 60)}`);
      if (task.files_touched.length > 0) {
        const fileList = task.files_touched.slice(0, 3).map(f => f.split('/').pop()).join(', ');
        lines.push(`  Files: ${fileList}`);
      }
      if (task.reasoning_trace.length > 0) {
        lines.push(`  Key: ${truncate(task.reasoning_trace[0], 80)}`);
      }
    }
    lines.push('');
  }

  // Add instruction
  if (files.length > 0) {
    lines.push(`You may already have context for: ${files.join(', ')}`);
  }
  lines.push('[END GROV CONTEXT]');

  return lines.join('\n');
}
