// Codex CLI adapter implementation

import type { FastifyRequest } from 'fastify';
import type { AgentSettings, NormalizedAction, ForwardResult, TokenUsage, ToolUseBlock } from '../types.js';
import type { CodexRequestBody, CodexResponse, CodexInputItem, CodexFunctionCall } from './types.js';
import type { ConversationMessage } from '../../../../core/extraction/llm-extractor.js';
import { BaseAdapter } from '../base.js';
import { forwardToOpenAI } from './forwarder.js';
import { parseCodexResponse } from './parser.js';
import {
  extractProjectPath,
  extractSessionId,
  extractGoalFromMessages,
  extractConversationHistory,
} from './extractors.js';
import { getSettingsPath, setProxyEnv } from './settings.js';

class CodexSettings implements AgentSettings {
  getConfigPath(): string {
    return getSettingsPath();
  }

  setProxyEnabled(enabled: boolean): { action: 'added' | 'removed' | 'unchanged' } {
    return setProxyEnv(enabled);
  }
}

export class CodexAdapter extends BaseAdapter {
  readonly name = 'codex' as const;
  readonly endpoint = '/v1/responses';

  private settings = new CodexSettings();

  canHandle(request: FastifyRequest): boolean {
    return request.url === '/v1/responses' || request.url.startsWith('/v1/responses?');
  }

  async forward(
    body: unknown,
    headers: Record<string, string>,
    rawBody?: Buffer
  ): Promise<ForwardResult> {
    const result = await forwardToOpenAI(body as Record<string, unknown>, headers, rawBody);
    return {
      statusCode: result.statusCode,
      headers: this.normalizeHeaders(result.headers),
      body: result.body,
      rawBody: result.rawBody,
      wasSSE: result.wasSSE,
    };
  }

  extractProjectPath(body: unknown): string | null {
    return extractProjectPath(body as CodexRequestBody);
  }

  extractSessionId(response: unknown): string | null {
    return extractSessionId(response as CodexResponse);
  }

  extractTextContent(response: unknown): string {
    const codexResponse = response as CodexResponse;
    const textParts: string[] = [];

    for (const item of codexResponse.output) {
      if (item.type === 'message' && item.content) {
        for (const content of item.content) {
          if (content.type === 'output_text') {
            textParts.push(content.text);
          }
        }
      }
    }

    return textParts.join('\n');
  }

  extractGoal(messages: unknown[]): string {
    return extractGoalFromMessages(messages as CodexInputItem[]) || '';
  }

  extractHistory(messages: unknown[]): ConversationMessage[] {
    return extractConversationHistory(messages as CodexInputItem[]);
  }

  extractUsage(response: unknown): TokenUsage {
    const codexResponse = response as CodexResponse;
    const usage = codexResponse.usage || { input_tokens: 0, output_tokens: 0 };
    return {
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      totalTokens: usage.total_tokens || (usage.input_tokens + usage.output_tokens),
      cacheCreation: 0,
      cacheRead: 0,
    };
  }

  isValidResponse(body: unknown): boolean {
    return (
      typeof body === 'object' &&
      body !== null &&
      'id' in body &&
      'status' in body &&
      'output' in body
    );
  }

  isSubagentModel(model: string): boolean {
    return model.includes('mini');
  }

  isEndTurn(response: unknown): boolean {
    const codexResponse = response as CodexResponse;
    if (codexResponse.status !== 'completed') return false;

    const hasFunctionCall = codexResponse.output.some(
      item => item.type === 'function_call'
    );
    return !hasFunctionCall;
  }

  isToolUse(response: unknown): boolean {
    const codexResponse = response as CodexResponse;
    return codexResponse.output.some(item => item.type === 'function_call');
  }

  parseActions(response: unknown): NormalizedAction[] {
    const codexResponse = response as CodexResponse;
    if (!codexResponse.output) {
      return [];
    }

    const parsedActions = parseCodexResponse(codexResponse);

    return parsedActions.map(action => ({
      toolName: action.toolName,
      actionType: action.actionType,
      sourceAgent: 'codex' as const,
      files: action.files,
      folders: action.folders,
      command: action.command,
      rawInput: action.rawInput,
    }));
  }

  getToolUseBlocks(response: unknown): ToolUseBlock[] {
    const codexResponse = response as CodexResponse;

    return codexResponse.output
      .filter((item): item is CodexFunctionCall => item.type === 'function_call')
      .map(item => ({
        id: item.call_id,
        name: item.name,
        input: this.parseToolInput(item.arguments),
      }));
  }

  findInternalToolUse(response: unknown, toolName: string): ToolUseBlock | null {
    const blocks = this.getToolUseBlocks(response);
    return blocks.find(block => block.name === toolName) || null;
  }

  injectMemory(body: unknown, memory: string): unknown {
    const codexBody = body as CodexRequestBody;

    return {
      ...codexBody,
      instructions: codexBody.instructions
        ? codexBody.instructions + '\n\n' + memory
        : memory,
    };
  }

  injectDelta(body: unknown, delta: string): unknown {
    const codexBody = body as CodexRequestBody;
    const input = [...codexBody.input];

    for (let i = input.length - 1; i >= 0; i--) {
      const item = input[i];
      if ('role' in item && item.role === 'user') {
        input[i] = {
          ...item,
          content: item.content + '\n\n' + delta,
        };
        break;
      }
    }

    return { ...codexBody, input };
  }

  injectTool(body: unknown, toolDef: unknown): unknown {
    const codexBody = body as CodexRequestBody;
    const existingTools = codexBody.tools || [];
    const tools = [...existingTools, toolDef];
    return { ...codexBody, tools };
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
    const codexBody = body as CodexRequestBody;
    return codexBody.input || [];
  }

  setMessages(body: unknown, messages: unknown[]): unknown {
    const codexBody = body as CodexRequestBody;
    return { ...codexBody, input: messages as CodexInputItem[] };
  }

  getLastUserContent(body: unknown): string {
    const input = this.getMessages(body) as CodexInputItem[];
    for (let i = input.length - 1; i >= 0; i--) {
      const item = input[i];
      if ('role' in item && item.role === 'user') {
        if (typeof item.content === 'string') {
          return item.content;
        }
        if (Array.isArray(item.content)) {
          // Handle specific Codex content array format
          return item.content
            .map(c => {
              if (typeof c === 'string') return c;
              if (c && typeof c === 'object' && 'text' in c) return (c as { text: string }).text;
              return '';
            })
            .join('\n');
        }
        return '';
      }
    }
    return '';
  }

  injectIntoRawSystemPrompt(rawBody: string, injection: string): { modified: string; success: boolean } {
    // Codex uses "instructions" as a string field, not an array
    const instructionsMatch = rawBody.match(/"instructions"\s*:\s*"/);
    if (instructionsMatch && instructionsMatch.index !== undefined) {
      // Find the end of the instructions string
      const startQuote = instructionsMatch.index + instructionsMatch[0].length - 1;
      let i = startQuote + 1;
      while (i < rawBody.length) {
        if (rawBody[i] === '\\') {
          i += 2;
        } else if (rawBody[i] === '"') {
          const insertPos = i;
          const escapedInjection = injection
            .replace(/\\/g, '\\\\')
            .replace(/"/g, '\\"')
            .replace(/\n/g, '\\n');
          const modified = rawBody.slice(0, insertPos) + '\\n\\n' + escapedInjection + rawBody.slice(insertPos);
          return { modified, success: true };
        } else {
          i++;
        }
      }
    }

    // No instructions field found - try to add one
    const inputMatch = rawBody.match(/"input"\s*:/);
    if (inputMatch && inputMatch.index !== undefined) {
      const escapedInjection = injection
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n');
      const insertStr = `"instructions":"${escapedInjection}",`;
      const modified = rawBody.slice(0, inputMatch.index) + insertStr + rawBody.slice(inputMatch.index);
      return { modified, success: true };
    }

    return { modified: rawBody, success: false };
  }

  injectIntoRawUserMessage(rawBody: string, injection: string): string {
    // Find the last user message in the input array
    const userRolePattern = /"role"\s*:\s*"user"/g;
    let lastUserMatch: RegExpExecArray | null = null;
    let match;

    while ((match = userRolePattern.exec(rawBody)) !== null) {
      lastUserMatch = match;
    }

    if (!lastUserMatch) {
      return rawBody;
    }

    // Find "content" field after role
    const afterRole = rawBody.slice(lastUserMatch.index);
    const contentMatch = afterRole.match(/"content"\s*:\s*"/);
    if (!contentMatch || contentMatch.index === undefined) {
      return rawBody;
    }

    const contentStartGlobal = lastUserMatch.index + contentMatch.index + contentMatch[0].length - 1;
    const afterContent = rawBody.slice(contentStartGlobal);

    // Codex user content is always a string
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

    return rawBody;
  }

  injectToolIntoRawBody(rawBody: string, toolDef: unknown): { modified: string; success: boolean } {
    const toolsMatch = rawBody.match(/"tools"\s*:\s*\[/);
    if (!toolsMatch || toolsMatch.index === undefined) {
      // No tools array - add one before input
      const inputMatch = rawBody.match(/"input"\s*:/);
      if (inputMatch && inputMatch.index !== undefined) {
        const toolsJson = JSON.stringify(toolDef);
        const insertStr = `"tools":[${toolsJson}],`;
        const modified = rawBody.slice(0, inputMatch.index) + insertStr + rawBody.slice(inputMatch.index);
        return { modified, success: true };
      }
      return { modified: rawBody, success: false };
    }

    // Find closing bracket
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
    const codexBody = body as CodexRequestBody;
    const input = [...codexBody.input];

    input.push({
      role: 'assistant',
      content: JSON.stringify(assistantContent),
    });

    input.push({
      type: 'function_call_output',
      call_id: toolId,
      output: toolResult,
    });

    return { ...codexBody, input };
  }

  getSettings(): AgentSettings {
    return this.settings;
  }

  private parseToolInput(argumentsJson: string): unknown {
    try {
      return JSON.parse(argumentsJson);
    } catch {
      return {};
    }
  }
}
