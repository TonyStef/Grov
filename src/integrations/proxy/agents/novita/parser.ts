import type { NormalizedAction } from '../types.js';
import type { NovitaResponse, NovitaToolCall } from './types.js';

export interface ParsedNovitaAction {
  toolName: string;
  actionType: string;
  files: string[];
  folders: string[];
  rawInput: unknown;
}

export function parseNovitaResponse(response: NovitaResponse): ParsedNovitaAction[] {
  const actions: ParsedNovitaAction[] = [];
  const choices = response.choices || [];

  for (const choice of choices) {
    const message = choice.message;

    if (message && 'tool_calls' in message && Array.isArray(message.tool_calls)) {
      for (const toolCall of message.tool_calls) {
        actions.push({
          toolName: toolCall.function.name,
          actionType: toolCall.function.name,
          files: [],
          folders: [],
          rawInput: toolCall.function.arguments,
        });
      }
    }

    if (message && 'content' in message && typeof message.content === 'string') {
      actions.push({
        toolName: 'output',
        actionType: 'message',
        files: [],
        folders: [],
        rawInput: message.content,
      });
    }
  }

  return actions;
}

export function parseToolCallArguments(argsString: string): unknown {
  try {
    return JSON.parse(argsString);
  } catch {
    return {};
  }
}
