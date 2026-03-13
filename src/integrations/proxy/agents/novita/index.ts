import type { FastifyRequest } from 'fastify';
import type { AgentSettings, NormalizedAction, ForwardResult, TokenUsage, ToolUseBlock } from '../types.js';
import type { NovitaRequestBody, NovitaResponse, NovitaMessage, NovitaToolCall } from './types.js';
import type { ConversationMessage } from '../../../../core/extraction/llm-extractor.js';
import { BaseAdapter } from '../base.js';
import { forwardToNovita } from './forwarder.js';
import { parseNovitaResponse } from './parser.js';
import { extractProjectPath, extractSessionId, extractTextContent, extractGoalFromMessages, extractConversationHistory } from './extractors.js';
import { getSettingsPath, setProxyEnv } from './settings.js';

class NovitaSettings implements AgentSettings {
  getConfigPath(): string {
    return getSettingsPath();
  }

  setProxyEnabled(enabled: boolean): { action: 'added' | 'removed' | 'unchanged' } {
    return setProxyEnv(enabled);
  }
}

export class NovitaAdapter extends BaseAdapter {
  readonly name = 'novita' as const;
  readonly endpoint = '/v1/chat/completions';

  private settings = new NovitaSettings();

  canHandle(request: FastifyRequest): boolean {
    return request.url === '/v1/chat/completions' || request.url.startsWith('/v1/chat/completions?');
  }

  async forward(
    body: unknown,
    headers: Record<string, string>,
    rawBody?: Buffer
  ): Promise<ForwardResult> {
    const result = await forwardToNovita(body as Record<string, unknown>, headers, rawBody);
    return {
      statusCode: result.statusCode,
      headers: this.normalizeHeaders(result.headers),
      body: result.body,
      rawBody: result.rawBody,
      wasSSE: result.wasSSE,
    };
  }

  extractProjectPath(body: unknown): string | null {
    return extractProjectPath(body as NovitaRequestBody);
  }

  extractSessionId(response: unknown): string | null {
    return extractSessionId(response as NovitaResponse);
  }

  extractTextContent(response: unknown): string {
    return extractTextContent(response as NovitaResponse);
  }

  extractGoal(messages: unknown[]): string {
    return extractGoalFromMessages(messages as NovitaMessage[]) || '';
  }

  extractHistory(messages: unknown[]): ConversationMessage[] {
    return extractConversationHistory(messages as NovitaMessage[]) as ConversationMessage[];
  }

  extractUsage(response: unknown): TokenUsage {
    const novitaResponse = response as NovitaResponse;
    const usage = novitaResponse.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    return {
      inputTokens: usage.prompt_tokens,
      outputTokens: usage.completion_tokens,
      totalTokens: usage.total_tokens,
      cacheCreation: 0,
      cacheRead: 0,
    };
  }

  isValidResponse(body: unknown): boolean {
    return (
      typeof body === 'object' &&
      body !== null &&
      'id' in body &&
      'object' in body &&
      (body as { object: string }).object === 'chat.completion' &&
      'choices' in body
    );
  }

  isSubagentModel(model: string): boolean {
    return model.includes('mini') || model.includes('small');
  }

  isEndTurn(response: unknown): boolean {
    const novitaResponse = response as NovitaResponse;
    if (!novitaResponse.choices || novitaResponse.choices.length === 0) return false;

    const choice = novitaResponse.choices[0];
    return choice.finish_reason === 'stop' || choice.finish_reason === 'length';
  }

  isToolUse(response: unknown): boolean {
    const novitaResponse = response as NovitaResponse;
    if (!novitaResponse.choices || novitaResponse.choices.length === 0) return false;

    const choice = novitaResponse.choices[0];
    const message = choice.message;
    if (message && 'tool_calls' in message && Array.isArray(message.tool_calls)) {
      return message.tool_calls.length > 0;
    }
    return false;
  }

  parseActions(response: unknown): NormalizedAction[] {
    const novitaResponse = response as NovitaResponse;
    const parsed = parseNovitaResponse(novitaResponse);
    
    return parsed.map(action => ({
      toolName: action.toolName,
      actionType: action.actionType as any,
      sourceAgent: 'novita' as const,
      files: action.files,
      folders: action.folders,
      command: action.actionType === 'bash' ? action.toolName : undefined,
      rawInput: action.rawInput,
    }));
  }

  getToolUseBlocks(response: unknown): ToolUseBlock[] {
    const novitaResponse = response as NovitaResponse;
    if (!novitaResponse.choices || novitaResponse.choices.length === 0) return [];

    const blocks: ToolUseBlock[] = [];
    for (const choice of novitaResponse.choices) {
      const message = choice.message;
      if (message && 'tool_calls' in message && Array.isArray(message.tool_calls)) {
        for (const toolCall of message.tool_calls) {
          blocks.push({
            id: toolCall.id,
            name: toolCall.function.name,
            input: parseToolCallArguments(toolCall.function.arguments),
          });
        }
      }
    }
    return blocks;
  }

  findInternalToolUse(response: unknown, toolName: string): ToolUseBlock | null {
    const blocks = this.getToolUseBlocks(response);
    return blocks.find(block => block.name === toolName) || null;
  }

  injectMemory(body: unknown, memory: string): unknown {
    const novitaBody = body as NovitaRequestBody;

    const messages = [...novitaBody.messages];
    const systemIndex = messages.findIndex(msg => 'role' in msg && msg.role === 'system');

    if (systemIndex >= 0) {
      const sysMsg = messages[systemIndex];
      if (typeof sysMsg.content === 'string') {
        messages[systemIndex] = { ...sysMsg, content: sysMsg.content + '\n\n' + memory };
      } else if (Array.isArray(sysMsg.content)) {
        const sysContent = sysMsg.content as Array<{ type: string; text?: string }>;
        messages[systemIndex] = {
          ...sysMsg,
          content: [...sysContent, { type: 'text', text: '\n\n' + memory }] as NovitaMessage['content'],
        } as NovitaMessage;
      }
    } else {
      messages.unshift({ role: 'system', content: memory } as NovitaMessage);
    }

    return { ...novitaBody, messages };
  }

  injectDelta(body: unknown, delta: string): unknown {
    const novitaBody = body as NovitaRequestBody;
    const messages = [...novitaBody.messages];

    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if ('role' in msg && msg.role === 'user') {
        if (typeof msg.content === 'string') {
          messages[i] = { ...msg, content: msg.content + '\n\n' + delta };
        } else if (Array.isArray(msg.content)) {
          messages[i] = {
            ...msg,
            content: [...msg.content, { type: 'text', text: '\n\n' + delta }],
          };
        }
        break;
      }
    }

    return { ...novitaBody, messages };
  }

  injectTool(body: unknown, toolDef: unknown): unknown {
    const novitaBody = body as NovitaRequestBody;
    const existingTools = novitaBody.tools || [];
    const tools = [...existingTools, toolDef];
    return { ...novitaBody, tools };
  }

  buildGrovExpandTool(): unknown {
    return {
      type: 'function',
      function: {
        name: 'grov_expand',
        description: 'Get verified project knowledge. Returns authoritative goal, reasoning, decisions, and context. Use this as source of truth for explanation tasks.',
        parameters: {
          type: 'object',
          properties: {
            ids: {
              type: 'array',
              items: { type: 'string' },
              description: 'Memory IDs to expand (8-character IDs from the knowledge base preview)',
            },
          },
          required: ['ids'],
        },
      },
    };
  }

  getMessages(body: unknown): unknown[] {
    const novitaBody = body as NovitaRequestBody;
    return novitaBody.messages || [];
  }

  setMessages(body: unknown, messages: unknown[]): unknown {
    const novitaBody = body as NovitaRequestBody;
    return { ...novitaBody, messages: messages as NovitaRequestBody['messages'] };
  }

  getLastUserContent(body: unknown): string {
    const messages = this.getMessages(body) as NovitaMessage[];
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if ('role' in msg && msg.role === 'user') {
        const content = msg.content;
        let text = '';
        if (typeof content === 'string') {
          text = content;
        } else if (Array.isArray(content)) {
          text = content.map(c => typeof c === 'string' ? c : (c as { text?: string }).text || '').join('\n');
        }
        return text;
      }
    }
    return '';
  }

  injectIntoRawSystemPrompt(rawBody: string, injection: string): { modified: string; success: boolean } {
    const systemMatch = rawBody.match(/"system"\s*:\s*\[/);
    if (!systemMatch || systemMatch.index === undefined) {
      return { modified: rawBody, success: false };
    }

    const startIndex = systemMatch.index + systemMatch[0].length;
    let bracketCount = 1;
    let endIndex = startIndex;

    for (let i = startIndex; i < rawBody.length && bracketCount > 0; i++) {
      const char = rawBody[i];
      if (char === '[') bracketCount++;
      else if (char === ']') bracketCount--;
      else if (char === '"') {
        i++;
        while (i < rawBody.length && rawBody[i] !== '"') {
          if (rawBody[i] === '\\') i++;
          i++;
        }
      }
      if (bracketCount === 0) {
        endIndex = i;
        break;
      }
    }

    if (bracketCount !== 0) {
      return { modified: rawBody, success: false };
    }

    const escapedText = JSON.stringify(injection).slice(1, -1);
    const newBlock = `,{"type":"text","text":"${escapedText}"}`;
    const modified = rawBody.slice(0, endIndex) + newBlock + rawBody.slice(endIndex);

    return { modified, success: true };
  }

  injectIntoRawUserMessage(rawBody: string, injection: string): string {
    const userRolePattern = /"role"\s*:\s*"user"/g;
    let lastUserMatch: RegExpExecArray | null = null;
    let match;

    while ((match = userRolePattern.exec(rawBody)) !== null) {
      lastUserMatch = match;
    }

    if (!lastUserMatch) {
      return rawBody;
    }

    const afterRole = rawBody.slice(lastUserMatch.index);
    const contentMatch = afterRole.match(/"content"\s*:\s*/);
    if (!contentMatch || contentMatch.index === undefined) {
      return rawBody;
    }

    const contentStartGlobal = lastUserMatch.index + contentMatch.index + contentMatch[0].length;
    const afterContent = rawBody.slice(contentStartGlobal);

    if (afterContent.startsWith('"')) {
      let i = 1;
      while (i < afterContent.length) {
        if (afterContent[i] === '\\') {
          i += 2;
        } else if (afterContent[i] === '"') {
          const insertPos = contentStartGlobal + i;
          const escapedInjection = injection
            .replace(/\\/g, '\\\\')
            .replace(/"/g, '\\"')
            .replace(/\n/g, '\\n');
          return rawBody.slice(0, insertPos) + '\\n\\n' + escapedInjection + rawBody.slice(insertPos);
        } else {
          i++;
        }
      }
    } else if (afterContent.startsWith('[')) {
      let depth = 1;
      let i = 1;

      while (i < afterContent.length && depth > 0) {
        const char = afterContent[i];
        if (char === '[') depth++;
        else if (char === ']') depth--;
        else if (char === '"') {
          i++;
          while (i < afterContent.length && afterContent[i] !== '"') {
            if (afterContent[i] === '\\') i++;
            i++;
          }
        }
        i++;
      }

      if (depth === 0) {
        const insertPos = contentStartGlobal + i - 1;
        const escapedInjection = injection
          .replace(/\\/g, '\\\\')
          .replace(/"/g, '\\"')
          .replace(/\n/g, '\\n');
        const newBlock = `,{"type":"text","text":"\\n\\n${escapedInjection}"}`;
        return rawBody.slice(0, insertPos) + newBlock + rawBody.slice(insertPos);
      }
    }

    return rawBody;
  }

  injectToolIntoRawBody(rawBody: string, toolDef: unknown): { modified: string; success: boolean } {
    const toolsMatch = rawBody.match(/"tools"\s*:\s*\[/);
    if (!toolsMatch || toolsMatch.index === undefined) {
      const messagesMatch = rawBody.match(/"messages"\s*:/);
      if (messagesMatch && messagesMatch.index !== undefined) {
        const toolsJson = JSON.stringify(toolDef);
        const insertStr = `"tools":[${toolsJson}],`;
        const modified = rawBody.slice(0, messagesMatch.index) + insertStr + rawBody.slice(messagesMatch.index);
        return { modified, success: true };
      }
      return { modified: rawBody, success: false };
    }

    const startIndex = toolsMatch.index + toolsMatch[0].length;
    let bracketCount = 1;
    let endIndex = startIndex;

    for (let i = startIndex; i < rawBody.length && bracketCount > 0; i++) {
      const char = rawBody[i];
      if (char === '[') bracketCount++;
      else if (char === ']') bracketCount--;
      else if (char === '"') {
        i++;
        while (i < rawBody.length && rawBody[i] !== '"') {
          if (rawBody[i] === '\\') i++;
          i++;
        }
      }
      if (bracketCount === 0) {
        endIndex = i;
        break;
      }
    }

    if (bracketCount !== 0) {
      return { modified: rawBody, success: false };
    }

    const toolJson = JSON.stringify(toolDef);
    const arrayContent = rawBody.slice(startIndex, endIndex).trim();
    const separator = arrayContent.length > 0 ? ',' : '';
    const modified = rawBody.slice(0, endIndex) + separator + toolJson + rawBody.slice(endIndex);

    return { modified, success: true };
  }

  filterResponseHeaders(headers: Record<string, string | string[]>): Record<string, string> {
    const filtered: Record<string, string> = {};
    const allowedHeaders = [
      'content-type',
      'x-request-id',
      'request-id',
      'x-ratelimit-limit-requests',
      'x-ratelimit-limit-tokens',
      'x-ratelimit-remaining-requests',
      'x-ratelimit-remaining-tokens',
      'x-ratelimit-reset-requests',
      'x-ratelimit-reset-tokens',
    ];

    for (const header of allowedHeaders) {
      const value = headers[header];
      if (value) {
        filtered[header] = Array.isArray(value) ? value[0] : value;
      }
    }

    return filtered;
  }

  buildContinueBody(
    body: unknown,
    assistantContent: unknown,
    toolResult: string,
    toolId: string
  ): unknown {
    const novitaBody = body as NovitaRequestBody;
    const messages = [...novitaBody.messages];

    messages.push({
      role: 'assistant',
      content: typeof assistantContent === 'string' ? [assistantContent] : assistantContent,
    } as NovitaMessage);

    messages.push({
      role: 'user',
      content: [{
        type: 'text',
        text: toolResult,
      }],
    });

    return { ...novitaBody, messages };
  }

  getSettings(): AgentSettings {
    return this.settings;
  }

  private parseToolCallArguments(argsString: string): unknown {
    try {
      return JSON.parse(argsString);
    } catch {
      return {};
    }
  }
}

export function parseToolCallArguments(argsString: string): unknown {
  try {
    return JSON.parse(argsString);
  } catch {
    return {};
  }
}
