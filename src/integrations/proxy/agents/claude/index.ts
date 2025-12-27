// Claude Code adapter implementation

import type { FastifyRequest } from 'fastify';
import type { AgentAdapter, AgentSettings, NormalizedAction, ForwardResult } from '../types.js';
import type { MessagesRequestBody } from '../../types.js';
import { forwardToAnthropic } from './forwarder.js';
import { parseToolUseBlocks, type AnthropicResponse } from './parser.js';
import { extractProjectPath, extractSessionId } from './extractors.js';
import { getSettingsPath, setProxyEnv } from './settings.js';

class ClaudeSettings implements AgentSettings {
  getConfigPath(): string {
    return getSettingsPath();
  }

  setProxyEnabled(enabled: boolean): { action: 'added' | 'removed' | 'unchanged' } {
    return setProxyEnv(enabled);
  }
}

export class ClaudeAdapter implements AgentAdapter {
  readonly name = 'claude' as const;
  readonly endpoint = '/v1/messages';

  private settings = new ClaudeSettings();

  canHandle(request: FastifyRequest): boolean {
    return request.url === '/v1/messages' || request.url.startsWith('/v1/messages?');
  }

  extractProjectPath(body: unknown): string | null {
    return extractProjectPath(body as MessagesRequestBody);
  }

  extractSessionId(response: unknown): string | null {
    return extractSessionId(response as AnthropicResponse);
  }

  async forward(body: unknown, headers: Record<string, string>): Promise<ForwardResult> {
    const result = await forwardToAnthropic(body as Record<string, unknown>, headers);
    return {
      statusCode: result.statusCode,
      headers: this.normalizeHeaders(result.headers),
      body: result.body,
      rawBody: result.rawBody,
    };
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

  getSettings(): AgentSettings {
    return this.settings;
  }

  private normalizeHeaders(headers: Record<string, string | string[]>): Record<string, string> {
    const normalized: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
      normalized[key] = Array.isArray(value) ? value[0] : value;
    }
    return normalized;
  }
}
