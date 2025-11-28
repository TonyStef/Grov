// Parse Claude Code session JSONL files from ~/.claude/projects/

import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join, basename, resolve, normalize } from 'path';
import { debugParser } from './debug.js';

const CLAUDE_PROJECTS_DIR = join(homedir(), '.claude', 'projects');

// Types for JSONL entries
interface JsonlEntry {
  type: 'user' | 'assistant' | 'system';
  message?: {
    role: string;
    content: string | ContentBlock[];
  };
  timestamp?: string;
  session_id?: string;
  [key: string]: unknown;
}

interface ContentBlock {
  type: string;
  text?: string;
  name?: string;        // tool name
  input?: unknown;      // tool input
  [key: string]: unknown;
}

// Parsed session data
export interface ParsedSession {
  sessionId: string;
  projectPath: string;
  startTime: string;
  endTime: string;
  userMessages: string[];
  assistantMessages: string[];
  toolCalls: ToolCall[];
  filesRead: string[];
  filesWritten: string[];
  rawEntries: JsonlEntry[];
}

export interface ToolCall {
  name: string;
  input: unknown;
  timestamp?: string;
}

/**
 * Encode a project path the same way Claude Code does
 * /Users/dev/myapp -> -Users-dev-myapp
 */
export function encodeProjectPath(projectPath: string): string {
  // Normalize the path first to prevent encoding malicious paths
  const normalized = projectPath.replace(/\.\.+/g, '.');
  return normalized.replace(/\//g, '-');
}

/**
 * Decode an encoded project path back to the original.
 * SECURITY: Validates that the decoded path doesn't contain traversal sequences.
 * @throws Error if path contains traversal sequences
 */
export function decodeProjectPath(encoded: string): string {
  // First char is always '-' representing the root '/'
  const decoded = encoded.replace(/-/g, '/');

  // SECURITY: Prevent path traversal attacks
  if (decoded.includes('..')) {
    throw new Error('Invalid path: traversal sequence detected');
  }

  return decoded;
}

/**
 * Validate that a file path is within the expected project boundary.
 * SECURITY: Prevents path traversal outside project directory.
 */
export function isPathWithinProject(projectPath: string, filePath: string): boolean {
  const resolvedProject = resolve(normalize(projectPath));
  const resolvedFile = resolve(normalize(filePath));
  return resolvedFile.startsWith(resolvedProject);
}

/**
 * Get the directory where Claude stores sessions for a project
 */
export function getProjectSessionsDir(projectPath: string): string {
  const encoded = encodeProjectPath(projectPath);
  return join(CLAUDE_PROJECTS_DIR, encoded);
}

// SECURITY: Valid session ID pattern (hex chars, dashes for UUIDs)
const SESSION_ID_PATTERN = /^[a-f0-9-]+$/i;

/**
 * Extract session ID from a JSONL file path
 * ~/.claude/projects/-Users-dev-myapp/abc123def456.jsonl -> abc123def456
 * SECURITY: Validates session ID format to prevent path confusion attacks.
 */
export function getSessionIdFromPath(jsonlPath: string): string {
  const sessionId = basename(jsonlPath, '.jsonl');

  // SECURITY: Validate session ID contains only safe characters
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    debugParser('Invalid session ID format: %s', sessionId.substring(0, 20));
    throw new Error('Invalid session ID format');
  }

  return sessionId;
}

/**
 * Get the current session ID for a project (from the most recent session file)
 */
export function getCurrentSessionId(projectPath: string): string | null {
  const latestFile = findLatestSessionFile(projectPath);
  return latestFile ? getSessionIdFromPath(latestFile) : null;
}

/**
 * Find the most recent session file for a project.
 * SECURITY: Handles TOCTOU race conditions gracefully.
 */
export function findLatestSessionFile(projectPath: string): string | null {
  const sessionsDir = getProjectSessionsDir(projectPath);

  if (!existsSync(sessionsDir)) {
    return null;
  }

  // SECURITY: Handle TOCTOU - files may be deleted between list and stat
  const files: { name: string; path: string; mtime: Date }[] = [];

  try {
    const entries = readdirSync(sessionsDir).filter(f => f.endsWith('.jsonl'));

    for (const f of entries) {
      const filePath = join(sessionsDir, f);
      try {
        // SECURITY: Wrap stat in try-catch to handle deleted files
        const stat = statSync(filePath);
        files.push({
          name: f,
          path: filePath,
          mtime: stat.mtime
        });
      } catch {
        // File was deleted between readdir and stat - skip it
        debugParser('File disappeared during listing: %s', f);
      }
    }
  } catch {
    // Directory may have been deleted
    debugParser('Could not read sessions directory: %s', sessionsDir);
    return null;
  }

  files.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

  return files.length > 0 ? files[0].path : null;
}

/**
 * List all session files for a project
 */
export function listSessionFiles(projectPath: string): string[] {
  const sessionsDir = getProjectSessionsDir(projectPath);

  if (!existsSync(sessionsDir)) {
    return [];
  }

  return readdirSync(sessionsDir)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => join(sessionsDir, f));
}

// SECURITY: Maximum entries to prevent memory exhaustion
const MAX_JSONL_ENTRIES = 10000;

/**
 * Parse a JSONL file into entries.
 * SECURITY: Limits entries to prevent memory exhaustion attacks.
 */
export function parseJsonlFile(filePath: string): JsonlEntry[] {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch {
    // File may have been deleted/moved between finding and reading
    debugParser('Could not read file: %s', filePath);
    return [];
  }

  const lines = content.trim().split('\n').filter(line => line.trim());

  const entries: JsonlEntry[] = [];

  for (const line of lines) {
    // SECURITY: Limit entries to prevent memory exhaustion
    if (entries.length >= MAX_JSONL_ENTRIES) {
      debugParser('Entry limit reached (%d), stopping parse', MAX_JSONL_ENTRIES);
      break;
    }

    try {
      const entry = JSON.parse(line) as JsonlEntry;
      entries.push(entry);
    } catch {
      // Skip malformed lines
      debugParser('Skipping malformed JSONL line');
    }
  }

  return entries;
}

/**
 * Extract text content from a message content array
 */
function extractTextContent(content: string | ContentBlock[]): string {
  if (typeof content === 'string') {
    return content;
  }

  return content
    .filter(block => block.type === 'text' && block.text)
    .map(block => block.text as string)
    .join('\n');
}

/**
 * Extract tool calls from assistant message content
 */
function extractToolCalls(content: string | ContentBlock[], timestamp?: string): ToolCall[] {
  if (typeof content === 'string') {
    return [];
  }

  return content
    .filter(block => block.type === 'tool_use' && block.name)
    .map(block => ({
      name: block.name as string,
      input: block.input,
      timestamp
    }));
}

/**
 * Parse a session file and extract structured data
 */
export function parseSession(filePath: string): ParsedSession {
  const entries = parseJsonlFile(filePath);
  const sessionId = basename(filePath, '.jsonl');

  const userMessages: string[] = [];
  const assistantMessages: string[] = [];
  const toolCalls: ToolCall[] = [];
  const filesRead = new Set<string>();
  const filesWritten = new Set<string>();
  let startTime = '';
  let endTime = '';
  let projectPath = '';

  for (const entry of entries) {
    // Track timestamps
    if (entry.timestamp) {
      if (!startTime) startTime = entry.timestamp;
      endTime = entry.timestamp;
    }

    // Extract user messages
    if (entry.type === 'user' && entry.message?.content) {
      const text = extractTextContent(entry.message.content);
      if (text) userMessages.push(text);
    }

    // Extract assistant messages and tool calls
    if (entry.type === 'assistant' && entry.message?.content) {
      const text = extractTextContent(entry.message.content);
      if (text) assistantMessages.push(text);

      const tools = extractToolCalls(entry.message.content, entry.timestamp);
      toolCalls.push(...tools);

      // Track files from tool calls
      for (const tool of tools) {
        const input = tool.input as Record<string, unknown> | undefined;
        if (input?.file_path && typeof input.file_path === 'string') {
          if (tool.name === 'Read') {
            filesRead.add(input.file_path);
          } else if (tool.name === 'Write' || tool.name === 'Edit') {
            filesWritten.add(input.file_path);
          }
        }
      }
    }
  }

  // Try to infer project path from file paths
  const allFiles = [...filesRead, ...filesWritten];
  if (allFiles.length > 0) {
    // Find common prefix
    const firstFile = allFiles[0];
    const parts = firstFile.split('/');
    // Assume project is a few levels deep (e.g., /Users/dev/project)
    if (parts.length >= 4) {
      projectPath = parts.slice(0, 4).join('/');
    }
  }

  return {
    sessionId,
    projectPath,
    startTime,
    endTime,
    userMessages,
    assistantMessages,
    toolCalls,
    filesRead: [...filesRead],
    filesWritten: [...filesWritten],
    rawEntries: entries
  };
}

/**
 * Get a summary of the session for LLM extraction
 */
export function getSessionSummary(session: ParsedSession): string {
  const lines: string[] = [];

  lines.push(`Session ID: ${session.sessionId}`);
  lines.push(`Time: ${session.startTime} to ${session.endTime}`);
  lines.push('');

  lines.push('## User Messages');
  session.userMessages.forEach((msg, i) => {
    lines.push(`[${i + 1}] ${msg.substring(0, 500)}${msg.length > 500 ? '...' : ''}`);
  });
  lines.push('');

  lines.push('## Files Read');
  session.filesRead.forEach(f => lines.push(`  - ${f}`));
  lines.push('');

  lines.push('## Files Written/Edited');
  session.filesWritten.forEach(f => lines.push(`  - ${f}`));
  lines.push('');

  lines.push('## Tool Calls');
  const toolSummary = session.toolCalls.reduce((acc, t) => {
    acc[t.name] = (acc[t.name] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  Object.entries(toolSummary).forEach(([name, count]) => {
    lines.push(`  - ${name}: ${count}x`);
  });

  return lines.join('\n');
}
