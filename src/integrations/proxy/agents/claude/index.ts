// Claude Code adapter implementation

import type { FastifyRequest } from 'fastify';
import type { AgentSettings, NormalizedAction, ForwardResult, TokenUsage, ToolUseBlock } from '../types.js';
import type { MessagesRequestBody } from '../../types.js';
import type { ConversationMessage } from '../../../../core/extraction/llm-extractor.js';
import { BaseAdapter } from '../base.js';
import { forwardToAnthropic } from './forwarder.js';
import { parseToolUseBlocks, extractTokenUsage, type AnthropicResponse } from './parser.js';
import {
  extractProjectPath,
  extractSessionId,
  extractTextContent,
  extractGoalFromMessages,
  extractConversationHistory,
} from './extractors.js';
import { getSettingsPath, setProxyEnv } from './settings.js';

class ClaudeSettings implements AgentSettings {
  getConfigPath(): string {
    return getSettingsPath();
  }

  setProxyEnabled(enabled: boolean): { action: 'added' | 'removed' | 'unchanged' } {
    return setProxyEnv(enabled);
  }
}

export class ClaudeAdapter extends BaseAdapter {
  readonly name = 'claude' as const;
  readonly endpoint = '/v1/messages';

  private settings = new ClaudeSettings();

  canHandle(request: FastifyRequest): boolean {
    return request.url === '/v1/messages' || request.url.startsWith('/v1/messages?');
  }

  async forward(
    body: unknown,
    headers: Record<string, string>,
    rawBody?: Buffer
  ): Promise<ForwardResult> {
    const result = await forwardToAnthropic(body as Record<string, unknown>, headers, undefined, rawBody);
    return {
      statusCode: result.statusCode,
      headers: this.normalizeHeaders(result.headers),
      body: result.body,
      rawBody: result.rawBody,
      wasSSE: result.wasSSE,
    };
  }

  extractProjectPath(body: unknown): string | null {
    return extractProjectPath(body as MessagesRequestBody);
  }

  extractSessionId(response: unknown): string | null {
    return extractSessionId(response as AnthropicResponse);
  }

  extractTextContent(response: unknown): string {
    return extractTextContent(response as AnthropicResponse);
  }

  extractGoal(messages: unknown[]): string {
    return extractGoalFromMessages(messages as Array<{ role: string; content: unknown }>) || '';
  }

  extractHistory(messages: unknown[]): ConversationMessage[] {
    return extractConversationHistory(messages as Array<{ role: string; content: unknown }>);
  }

  extractUsage(response: unknown): TokenUsage {
    return extractTokenUsage(response as AnthropicResponse);
  }

  isValidResponse(body: unknown): boolean {
    return (
      typeof body === 'object' &&
      body !== null &&
      'type' in body &&
      (body as Record<string, unknown>).type === 'message' &&
      'content' in body &&
      'usage' in body
    );
  }

  isSubagentModel(model: string): boolean {
    return model.includes('haiku');
  }

  isEndTurn(response: unknown): boolean {
    return (response as AnthropicResponse).stop_reason === 'end_turn';
  }

  isToolUse(response: unknown): boolean {
    return (response as AnthropicResponse).stop_reason === 'tool_use';
  }

  parseActions(response: unknown): NormalizedAction[] {
    const anthropicResponse = response as AnthropicResponse;
    if (!anthropicResponse.content) {
      return [];
    }

    const parsedActions = parseToolUseBlocks(anthropicResponse);

    return parsedActions.map(action => ({
      toolName: action.toolName,
      actionType: action.actionType,
      sourceAgent: 'claude' as const,
      files: action.files,
      folders: action.folders,
      command: action.command,
      rawInput: action.rawInput,
    }));
  }

  getToolUseBlocks(response: unknown): ToolUseBlock[] {
    const anthropicResponse = response as AnthropicResponse;
    if (!anthropicResponse.content) {
      return [];
    }

    const blocks: ToolUseBlock[] = [];
    for (const block of anthropicResponse.content) {
      if (block.type === 'tool_use') {
        const toolBlock = block as { type: 'tool_use'; id: string; name: string; input: unknown };
        blocks.push({
          id: toolBlock.id,
          name: toolBlock.name,
          input: toolBlock.input,
        });
      }
    }
    return blocks;
  }

  findInternalToolUse(response: unknown, toolName: string): ToolUseBlock | null {
    const blocks = this.getToolUseBlocks(response);
    return blocks.find(block => block.name === toolName) || null;
  }

  injectMemory(body: unknown, memory: string): unknown {
    const claudeBody = body as MessagesRequestBody;

    if (typeof claudeBody.system === 'string') {
      return {
        ...claudeBody,
        system: claudeBody.system + '\n\n' + memory,
      };
    }

    if (Array.isArray(claudeBody.system)) {
      return {
        ...claudeBody,
        system: [
          ...claudeBody.system,
          { type: 'text', text: '\n\n' + memory },
        ],
      };
    }

    return {
      ...claudeBody,
      system: memory,
    };
  }

  injectDelta(body: unknown, delta: string): unknown {
    const claudeBody = body as MessagesRequestBody;
    const messages = [...claudeBody.messages];

    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        const msg = messages[i];
        if (typeof msg.content === 'string') {
          messages[i] = {
            ...msg,
            content: msg.content + '\n\n' + delta,
          };
        } else if (Array.isArray(msg.content)) {
          messages[i] = {
            ...msg,
            content: [
              ...msg.content,
              { type: 'text', text: '\n\n' + delta },
            ],
          };
        }
        break;
      }
    }

    return {
      ...claudeBody,
      messages,
    };
  }

  injectTool(body: unknown, toolDef: unknown): unknown {
    const claudeBody = body as MessagesRequestBody;
    const existingTools = claudeBody.tools || [];
    const tools = [...existingTools, toolDef];
    return { ...claudeBody, tools };
  }

  filterResponseHeaders(headers: Record<string, string | string[]>): Record<string, string> {
    const filtered: Record<string, string> = {};
    const allowedHeaders = [
      'content-type',
      'x-request-id',
      'request-id',
      'x-should-retry',
      'retry-after',
      'retry-after-ms',
      'anthropic-ratelimit-requests-limit',
      'anthropic-ratelimit-requests-remaining',
      'anthropic-ratelimit-requests-reset',
      'anthropic-ratelimit-tokens-limit',
      'anthropic-ratelimit-tokens-remaining',
      'anthropic-ratelimit-tokens-reset',
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
    const claudeBody = body as MessagesRequestBody;
    const messages = [...claudeBody.messages];

    messages.push({
      role: 'assistant',
      content: assistantContent as MessagesRequestBody['messages'][number]['content'],
    });

    messages.push({
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: toolId,
        content: toolResult,
      }],
    });

    return { ...claudeBody, messages };
  }

  getSettings(): AgentSettings {
    return this.settings;
  }
}
