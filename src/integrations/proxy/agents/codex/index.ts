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
