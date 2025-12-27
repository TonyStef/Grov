// Codex CLI adapter implementation

import type { FastifyRequest } from 'fastify';
import type { AgentAdapter, AgentSettings, NormalizedAction, ForwardResult } from '../types.js';
import type { CodexRequestBody, CodexResponse } from './types.js';
import { forwardToOpenAI } from './forwarder.js';
import { parseCodexResponse } from './parser.js';
import { extractProjectPath, extractSessionId } from './extractors.js';
import { getSettingsPath, setProxyEnv } from './settings.js';

class CodexSettings implements AgentSettings {
  getConfigPath(): string {
    return getSettingsPath();
  }

  setProxyEnabled(enabled: boolean): { action: 'added' | 'removed' | 'unchanged' } {
    return setProxyEnv(enabled);
  }
}

export class CodexAdapter implements AgentAdapter {
  readonly name = 'codex' as const;
  readonly endpoint = '/v1/responses';

  private settings = new CodexSettings();

  canHandle(request: FastifyRequest): boolean {
    return request.url === '/v1/responses' || request.url.startsWith('/v1/responses?');
  }

  extractProjectPath(body: unknown): string | null {
    return extractProjectPath(body as CodexRequestBody);
  }

  extractSessionId(response: unknown): string | null {
    return extractSessionId(response as CodexResponse);
  }

  async forward(body: unknown, headers: Record<string, string>): Promise<ForwardResult> {
    const result = await forwardToOpenAI(body as Record<string, unknown>, headers);
    return {
      statusCode: result.statusCode,
      headers: this.normalizeHeaders(result.headers),
      body: result.body,
      rawBody: result.rawBody,
    };
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
