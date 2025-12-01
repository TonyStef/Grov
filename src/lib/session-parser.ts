// Session JSONL parser for anti-drift system
// Parses Claude Code session files to extract Claude's ACTIONS (tool calls)
//
// CRITICAL: We monitor Claude's ACTIONS, NOT user prompts.
// User can explore freely. We check what CLAUDE DOES.

import { existsSync, readFileSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { debugInject } from './debug.js';

// ============================================
// INTERFACES
// ============================================

/**
 * Claude's action extracted from session JSONL
 */
export interface ClaudeAction {
  type: 'edit' | 'write' | 'bash' | 'read' | 'delete' | 'grep' | 'glob' | 'multiedit';
  files: string[];
  command?: string;  // For bash actions
  timestamp: number;
}

/**
 * JSONL entry structure (simplified)
 */
interface JournalEntry {
  type: 'assistant' | 'user' | 'result' | 'summary';
  timestamp: string;
  message?: {
    content?: Array<{
      type: string;
      name?: string;
      input?: Record<string, unknown>;
    }>;
  };
}

// ============================================
// MAIN FUNCTIONS
// ============================================

/**
 * Find session JSONL path from session_id and project path.
 *
 * Claude Code stores sessions in:
 *   ~/.claude/projects/<encoded-path>/<session_id>.jsonl
 *
 * The encoded path uses a specific encoding (not standard URL encoding).
 */
export function findSessionFile(sessionId: string, projectPath: string): string | null {
  const claudeProjectsDir = join(homedir(), '.claude', 'projects');

  if (!existsSync(claudeProjectsDir)) {
    debugInject('Claude projects dir not found: %s', claudeProjectsDir);
    return null;
  }

  // Try to find the project folder
  // Claude Code uses a specific encoding for the path
  // We'll search for folders that might contain our session
  const projectFolders = readdirSync(claudeProjectsDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);

  // First, try URL-encoded path
  const urlEncoded = encodeURIComponent(projectPath);
  if (projectFolders.includes(urlEncoded)) {
    const sessionPath = join(claudeProjectsDir, urlEncoded, `${sessionId}.jsonl`);
    if (existsSync(sessionPath)) {
      debugInject('Found session via URL encoding: %s', sessionPath);
      return sessionPath;
    }
  }

  // Try custom Claude encoding (%2F for /, etc.)
  const customEncoded = projectPath
    .replace(/\//g, '%2F')
    .replace(/:/g, '%3A');
  if (projectFolders.includes(customEncoded)) {
    const sessionPath = join(claudeProjectsDir, customEncoded, `${sessionId}.jsonl`);
    if (existsSync(sessionPath)) {
      debugInject('Found session via custom encoding: %s', sessionPath);
      return sessionPath;
    }
  }

  // Search in all project folders for the session
  for (const folder of projectFolders) {
    const sessionPath = join(claudeProjectsDir, folder, `${sessionId}.jsonl`);
    if (existsSync(sessionPath)) {
      debugInject('Found session by scanning: %s', sessionPath);
      return sessionPath;
    }
  }

  debugInject('Session file not found for: %s in %s', sessionId, projectPath);
  return null;
}

/**
 * Parse JSONL and extract ALL Claude's tool calls
 */
export function parseSessionActions(sessionPath: string): ClaudeAction[] {
  if (!existsSync(sessionPath)) {
    debugInject('Session file does not exist: %s', sessionPath);
    return [];
  }

  const content = readFileSync(sessionPath, 'utf-8');
  const lines = content.trim().split('\n').filter(Boolean);
  const actions: ClaudeAction[] = [];

  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as JournalEntry;

      // Only process assistant messages (Claude's responses)
      if (entry.type !== 'assistant') continue;

      const timestamp = new Date(entry.timestamp).getTime();

      // Extract tool calls from content array
      for (const block of entry.message?.content || []) {
        if (block.type !== 'tool_use') continue;

        const action = parseToolCall(block, timestamp);
        if (action) {
          actions.push(action);
        }
      }
    } catch {
      // Skip malformed lines silently
      continue;
    }
  }

  debugInject('Parsed %d actions from session', actions.length);
  return actions;
}

/**
 * Get only NEW actions since last check timestamp.
 * This is the main function used by prompt-inject.
 */
export function getNewActions(sessionPath: string, lastCheckedTimestamp: number): ClaudeAction[] {
  const allActions = parseSessionActions(sessionPath);
  const newActions = allActions.filter(a => a.timestamp > lastCheckedTimestamp);

  debugInject('Found %d new actions since %d', newActions.length, lastCheckedTimestamp);
  return newActions;
}

/**
 * Get actions that MODIFY files (not reads).
 * Use this for drift detection - reads are exploration, not drift.
 */
export function getModifyingActions(actions: ClaudeAction[]): ClaudeAction[] {
  return actions.filter(a => a.type !== 'read' && a.type !== 'grep' && a.type !== 'glob');
}

/**
 * Extract all unique files touched by actions
 */
export function extractFilesFromActions(actions: ClaudeAction[]): string[] {
  const files = new Set<string>();
  for (const action of actions) {
    for (const file of action.files) {
      files.add(file);
    }
  }
  return [...files];
}

/**
 * Extract unique folders from actions
 */
export function extractFoldersFromActions(actions: ClaudeAction[]): string[] {
  const folders = new Set<string>();
  for (const action of actions) {
    for (const file of action.files) {
      const folder = dirname(file);
      if (folder && folder !== '.') {
        folders.add(folder);
      }
    }
  }
  return [...folders];
}

// ============================================
// HELPERS
// ============================================

/**
 * Parse a single tool call block into ClaudeAction
 */
function parseToolCall(
  block: { name?: string; input?: Record<string, unknown> },
  timestamp: number
): ClaudeAction | null {
  const name = block.name?.toLowerCase();
  const input = block.input || {};

  switch (name) {
    case 'edit':
      return {
        type: 'edit',
        files: [input.file_path as string].filter(Boolean),
        timestamp
      };

    case 'multiedit':
      return {
        type: 'multiedit',
        files: [input.file_path as string].filter(Boolean),
        timestamp
      };

    case 'write':
      return {
        type: 'write',
        files: [input.file_path as string].filter(Boolean),
        timestamp
      };

    case 'bash':
      return {
        type: 'bash',
        files: extractFilesFromCommand(input.command as string || ''),
        command: input.command as string,
        timestamp
      };

    case 'read':
      return {
        type: 'read',
        files: [input.file_path as string].filter(Boolean),
        timestamp
      };

    case 'grep':
      return {
        type: 'grep',
        files: [input.path as string].filter(Boolean),
        timestamp
      };

    case 'glob':
      return {
        type: 'glob',
        files: [input.path as string].filter(Boolean),
        timestamp
      };

    default:
      // Ignore other tools (Task, WebFetch, etc.)
      return null;
  }
}

/**
 * Extract file paths from a bash command.
 * Basic extraction - not perfect but catches common patterns.
 */
function extractFilesFromCommand(command: string): string[] {
  if (!command) return [];

  const files: string[] = [];
  const patterns = [
    // Absolute paths: /path/to/file.ts
    /(?:^|\s)(\/[\w\-\.\/]+\.\w+)/g,
    // Relative paths with ./: ./src/file.ts
    /(?:^|\s)(\.\/[\w\-\.\/]+\.\w+)/g,
    // Relative paths: src/file.ts
    /(?:^|\s)([\w\-]+\/[\w\-\.\/]+\.\w+)/g,
  ];

  for (const pattern of patterns) {
    for (const match of command.matchAll(pattern)) {
      const file = match[1];
      // Filter out common non-files
      if (file && !file.startsWith('http') && !file.match(/^\d+\.\d+/)) {
        files.push(file);
      }
    }
  }

  return [...new Set(files)];
}

/**
 * Extract keywords from an action (for step storage)
 */
export function extractKeywordsFromAction(action: ClaudeAction): string[] {
  const keywords: string[] = [];

  // Extract from file names
  for (const file of action.files) {
    const fileName = file.split('/').pop() || '';
    const baseName = fileName.replace(/\.\w+$/, '');

    // Split camelCase and kebab-case
    const parts = baseName
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/[-_]/g, ' ')
      .toLowerCase()
      .split(/\s+/)
      .filter(p => p.length > 2);

    keywords.push(...parts);
  }

  // Extract from bash command
  if (action.command) {
    const commandParts = action.command
      .toLowerCase()
      .split(/\s+/)
      .filter(p => p.length > 3 && !p.startsWith('-'));
    keywords.push(...commandParts.slice(0, 5));
  }

  return [...new Set(keywords)];
}
