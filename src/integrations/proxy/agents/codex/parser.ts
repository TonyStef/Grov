// Parse shell function calls from Codex responses

import type { StepActionType } from '../../../../core/store/store.js';
import type { CodexResponse, CodexFunctionCall, ShellArguments } from './types.js';
import { parsePatchContent } from './patch.js';

export interface ParsedCodexAction {
  toolName: string;
  actionType: StepActionType;
  files: string[];
  folders: string[];
  command?: string;
  rawInput: unknown;
}

export function parseCodexResponse(response: CodexResponse): ParsedCodexAction[] {
  const actions: ParsedCodexAction[] = [];

  for (const item of response.output) {
    if (item.type !== 'function_call' || item.name !== 'shell') continue;

    const args = parseShellArguments(item.arguments);
    if (!args) continue;

    const action = parseShellCommand(args);
    if (action) actions.push(action);
  }

  return actions;
}

function parseShellArguments(argsJson: string): ShellArguments | null {
  try {
    return JSON.parse(argsJson);
  } catch {
    return null;
  }
}

function parseShellCommand(args: ShellArguments): ParsedCodexAction | null {
  const { command, workdir } = args;
  if (command.length === 0) return null;

  const [cmd, ...cmdArgs] = command;

  if (cmd === 'cat' || cmd === 'head' || cmd === 'tail') {
    return {
      toolName: `shell:${cmd}`,
      actionType: 'read',
      files: extractFilePaths(cmdArgs),
      folders: [],
      rawInput: args,
    };
  }

  if (cmd === 'apply_patch') {
    const patchContent = cmdArgs[0] || '';
    const patchInfo = parsePatchContent(patchContent);
    return {
      toolName: 'shell:apply_patch',
      actionType: patchInfo.hasAdd ? 'write' : 'edit',
      files: patchInfo.files,
      folders: [],
      rawInput: args,
    };
  }

  if (cmd === 'rg') {
    if (cmdArgs.includes('--files')) {
      return {
        toolName: 'shell:rg',
        actionType: 'glob',
        files: [],
        folders: extractPaths(cmdArgs),
        rawInput: args,
      };
    }
    return {
      toolName: 'shell:rg',
      actionType: 'grep',
      files: [],
      folders: extractPaths(cmdArgs),
      rawInput: args,
    };
  }

  if (cmd === 'ls') {
    return {
      toolName: 'shell:ls',
      actionType: 'glob',
      files: [],
      folders: extractPaths(cmdArgs),
      rawInput: args,
    };
  }

  if (cmd === 'bash') {
    const actualCmd = cmdArgs.includes('-lc')
      ? cmdArgs[cmdArgs.indexOf('-lc') + 1]
      : cmdArgs.join(' ');
    return {
      toolName: 'shell:bash',
      actionType: 'bash',
      files: [],
      folders: [],
      command: actualCmd,
      rawInput: args,
    };
  }

  return {
    toolName: 'shell',
    actionType: 'bash',
    files: [],
    folders: [],
    command: command.join(' '),
    rawInput: args,
  };
}

function extractFilePaths(args: string[]): string[] {
  return args.filter(arg => !arg.startsWith('-') && (arg.includes('/') || arg.includes('.')));
}

function extractPaths(args: string[]): string[] {
  return args.filter(arg => !arg.startsWith('-') && arg.length > 0);
}
