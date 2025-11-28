// grov prompt-inject - Called by UserPromptSubmit hook, outputs context JSON
// This provides continuous context injection on every user prompt

import {
  getTasksForProject,
  getTasksByFiles,
  getFileReasoningByPathPattern,
  type Task,
} from '../lib/store.js';

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
    if (process.env.GROV_DEBUG) {
      console.error('[grov] prompt-inject error:', error);
    }
  }
}

/**
 * Read JSON input from stdin with timeout
 */
async function readStdinInput(): Promise<PromptInput | null> {
  return new Promise((resolve) => {
    // Set a timeout to prevent hanging
    const timeout = setTimeout(() => {
      resolve(null);
    }, 3000); // 3 second timeout

    let data = '';

    process.stdin.setEncoding('utf-8');

    process.stdin.on('readable', () => {
      let chunk;
      while ((chunk = process.stdin.read()) !== null) {
        data += chunk;
      }
    });

    process.stdin.on('end', () => {
      clearTimeout(timeout);
      try {
        const parsed = JSON.parse(data.trim());
        resolve(parsed);
      } catch {
        if (process.env.GROV_DEBUG) {
          console.error('[grov] Failed to parse stdin JSON');
        }
        resolve(null);
      }
    });

    process.stdin.on('error', () => {
      clearTimeout(timeout);
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
 * Extract file paths from a prompt
 */
function extractFilePaths(prompt: string): string[] {
  const patterns = [
    // Absolute paths: /Users/dev/file.ts
    /(?:^|\s)(\/[\w\-\.\/]+\.\w+)/g,
    // Relative paths with ./: ./src/file.ts
    /(?:^|\s)(\.\/[\w\-\.\/]+\.\w+)/g,
    // Relative paths: src/file.ts or path/to/file.ts
    /(?:^|\s)([\w\-]+\/[\w\-\.\/]+\.\w+)/g,
    // Simple filenames with extension: file.ts
    /(?:^|\s|['"`])([\w\-]+\.\w{1,5})(?:\s|$|,|:|['"`])/g,
  ];

  const files = new Set<string>();

  for (const pattern of patterns) {
    const matches = prompt.matchAll(pattern);
    for (const match of matches) {
      const file = match[1].trim();
      // Filter out common non-file matches
      if (file && !file.match(/^(http|https|ftp|mailto|tel)/) && !file.match(/^\d+\.\d+/)) {
        files.add(file);
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
 * Find tasks that match keywords from the prompt
 */
function findKeywordMatches(prompt: string, tasks: Task[]): Task[] {
  const keywords = extractKeywords(prompt);

  if (keywords.length === 0) {
    return [];
  }

  return tasks.filter(task => {
    // Match against task tags
    const tagMatch = task.tags.some(tag =>
      keywords.some(kw => tag.toLowerCase().includes(kw) || kw.includes(tag.toLowerCase()))
    );

    // Match against goal
    const goalWords = extractKeywords(task.goal || '');
    const goalMatch = goalWords.some(gw =>
      keywords.some(kw => kw.includes(gw) || gw.includes(kw))
    );

    // Match against original query
    const queryWords = extractKeywords(task.original_query);
    const queryMatch = queryWords.some(qw =>
      keywords.some(kw => kw.includes(qw) || qw.includes(kw))
    );

    return tagMatch || goalMatch || queryMatch;
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

/**
 * Truncate string to max length
 */
function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return str.substring(0, maxLength - 3) + '...';
}
