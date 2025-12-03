// Parse tool_use blocks from Anthropic API response
// Replaces JSONL parsing - works with API response JSON directly

import type { StepActionType } from '../lib/store.js';

// Anthropic API response structure
export interface AnthropicResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  content: ContentBlock[];
  model: string;
  stop_reason: string | null;
  stop_sequence: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

export type ContentBlock = TextBlock | ToolUseBlock | ThinkingBlock;

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ThinkingBlock {
  type: 'thinking';
  thinking: string;
}

// Parsed action from tool_use
export interface ParsedAction {
  toolName: string;
  toolId: string;
  actionType: StepActionType;
  files: string[];
  folders: string[];
  command?: string;
  rawInput: Record<string, unknown>;
}

// Tool name to action type mapping
const TOOL_ACTION_MAP: Record<string, StepActionType> = {
  'Edit': 'edit',
  'Write': 'write',
  'Read': 'read',
  'Bash': 'bash',
  'Glob': 'glob',
  'Grep': 'grep',
  'Task': 'task',
  'MultiEdit': 'edit',
  'NotebookEdit': 'edit',
};

/**
 * Parse tool_use blocks from Anthropic API response
 */
export function parseToolUseBlocks(response: AnthropicResponse): ParsedAction[] {
  const actions: ParsedAction[] = [];

  for (const block of response.content) {
    if (block.type === 'tool_use') {
      const action = parseToolUseBlock(block);
      if (action) {
        actions.push(action);
      }
    }
  }

  return actions;
}

/**
 * Parse a single tool_use block
 */
function parseToolUseBlock(block: ToolUseBlock): ParsedAction | null {
  const actionType = TOOL_ACTION_MAP[block.name] || 'other';
  const files: string[] = [];
  const folders: string[] = [];
  let command: string | undefined;

  // Extract file paths based on tool type
  switch (block.name) {
    case 'Edit':
    case 'Write':
    case 'Read':
    case 'NotebookEdit':
      if (typeof block.input.file_path === 'string') {
        files.push(block.input.file_path);
      }
      if (typeof block.input.notebook_path === 'string') {
        files.push(block.input.notebook_path);
      }
      break;

    case 'MultiEdit':
      // MultiEdit has an array of edits
      if (Array.isArray(block.input.edits)) {
        for (const edit of block.input.edits) {
          if (typeof edit === 'object' && edit && typeof edit.file_path === 'string') {
            files.push(edit.file_path);
          }
        }
      }
      break;

    case 'Bash':
      if (typeof block.input.command === 'string') {
        command = block.input.command;
        // Try to extract file paths from common command patterns
        const bashFiles = extractFilesFromBashCommand(command);
        files.push(...bashFiles);
      }
      break;

    case 'Glob':
      if (typeof block.input.path === 'string') {
        folders.push(block.input.path);
      }
      if (typeof block.input.pattern === 'string') {
        // pattern might contain path info
        const patternPath = extractPathFromGlobPattern(block.input.pattern);
        if (patternPath) {
          folders.push(patternPath);
        }
      }
      break;

    case 'Grep':
      if (typeof block.input.path === 'string') {
        folders.push(block.input.path);
      }
      break;
  }

  return {
    toolName: block.name,
    toolId: block.id,
    actionType,
    files: [...new Set(files)],
    folders: [...new Set(folders)],
    command,
    rawInput: block.input
  };
}

/**
 * Extract file paths from bash command
 */
function extractFilesFromBashCommand(command: string): string[] {
  const files: string[] = [];

  // Match absolute paths
  const absolutePathRegex = /(?:^|\s)(\/[^\s"']+)/g;
  let match;
  while ((match = absolutePathRegex.exec(command)) !== null) {
    const path = match[1];
    // Filter out common non-file paths
    if (!path.startsWith('/dev/') && !path.startsWith('/proc/') && !path.startsWith('/sys/')) {
      files.push(path);
    }
  }

  // Match quoted paths
  const quotedPathRegex = /["'](\/[^"']+)["']/g;
  while ((match = quotedPathRegex.exec(command)) !== null) {
    files.push(match[1]);
  }

  return files;
}

/**
 * Extract base path from glob pattern
 */
function extractPathFromGlobPattern(pattern: string): string | null {
  // e.g., "src/**/*.ts" -> "src"
  const parts = pattern.split('/');
  const nonGlobParts: string[] = [];

  for (const part of parts) {
    if (part.includes('*') || part.includes('?') || part.includes('[')) {
      break;
    }
    nonGlobParts.push(part);
  }

  return nonGlobParts.length > 0 ? nonGlobParts.join('/') : null;
}

/**
 * Extract token usage from response
 */
export function extractTokenUsage(response: AnthropicResponse): {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
} {
  return {
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    totalTokens: response.usage.input_tokens + response.usage.output_tokens
  };
}

/**
 * Check if response contains any file-modifying actions
 */
export function hasModifyingActions(actions: ParsedAction[]): boolean {
  return actions.some(a =>
    a.actionType === 'edit' ||
    a.actionType === 'write' ||
    (a.actionType === 'bash' && a.command && isModifyingBashCommand(a.command))
  );
}

/**
 * Check if bash command modifies files
 */
function isModifyingBashCommand(command: string): boolean {
  const modifyingPatterns = [
    /\brm\b/,
    /\bmv\b/,
    /\bcp\b/,
    /\bmkdir\b/,
    /\btouch\b/,
    /\bchmod\b/,
    /\bchown\b/,
    /\bsed\b.*-i/,
    /\btee\b/,
    />/,  // redirect
    /\bgit\s+(add|commit|push|checkout|reset)/,
    /\bnpm\s+(install|uninstall)/,
    /\byarn\s+(add|remove)/,
  ];

  return modifyingPatterns.some(p => p.test(command));
}

/**
 * Get all unique files from actions
 */
export function getAllFiles(actions: ParsedAction[]): string[] {
  const files = new Set<string>();
  for (const action of actions) {
    for (const file of action.files) {
      files.add(file);
    }
  }
  return [...files];
}

/**
 * Get all unique folders from actions
 */
export function getAllFolders(actions: ParsedAction[]): string[] {
  const folders = new Set<string>();
  for (const action of actions) {
    for (const folder of action.folders) {
      folders.add(folder);
    }
  }
  return [...folders];
}
