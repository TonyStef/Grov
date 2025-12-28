// Base adapter with shared implementations

import type { FastifyRequest } from 'fastify';
import type {
  AgentAdapter,
  AgentName,
  AgentSettings,
  ForwardResult,
  NormalizedAction,
  TokenUsage,
  ToolUseBlock,
} from './types.js';
import type { ConversationMessage } from '../../../core/extraction/llm-extractor.js';

export abstract class BaseAdapter implements AgentAdapter {
  abstract readonly name: AgentName;
  abstract readonly endpoint: string;

  getResponseContentType(wasSSE: boolean): string {
    return wasSSE ? 'text/event-stream; charset=utf-8' : 'application/json';
  }

  protected normalizeHeaders(headers: Record<string, string | string[]>): Record<string, string> {
    const normalized: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
      normalized[key] = Array.isArray(value) ? value[0] : value;
    }
    return normalized;
  }

  abstract canHandle(request: FastifyRequest): boolean;
  abstract forward(body: unknown, headers: Record<string, string>, rawBody?: Buffer): Promise<ForwardResult>;
  abstract extractProjectPath(body: unknown): string | null;
  abstract extractSessionId(response: unknown): string | null;
  abstract extractTextContent(response: unknown): string;
  abstract extractGoal(messages: unknown[]): string;
  abstract extractHistory(messages: unknown[]): ConversationMessage[];
  abstract extractUsage(response: unknown): TokenUsage;
  abstract isValidResponse(body: unknown): boolean;
  abstract isSubagentModel(model: string): boolean;
  abstract isEndTurn(response: unknown): boolean;
  abstract isToolUse(response: unknown): boolean;
  abstract parseActions(response: unknown): NormalizedAction[];
  abstract getToolUseBlocks(response: unknown): ToolUseBlock[];
  abstract findInternalToolUse(response: unknown, toolName: string): ToolUseBlock | null;
  abstract injectMemory(body: unknown, memory: string): unknown;
  abstract injectDelta(body: unknown, delta: string): unknown;
  abstract injectTool(body: unknown, toolDef: unknown): unknown;
  abstract getMessages(body: unknown): unknown[];
  abstract setMessages(body: unknown, messages: unknown[]): unknown;
  abstract getLastUserContent(body: unknown): string;
  abstract injectIntoRawSystemPrompt(rawBody: string, injection: string): { modified: string; success: boolean };
  abstract injectIntoRawUserMessage(rawBody: string, injection: string): string;
  abstract injectToolIntoRawBody(rawBody: string, toolDef: unknown): { modified: string; success: boolean };
  abstract filterResponseHeaders(headers: Record<string, string | string[]>): Record<string, string>;
  abstract buildContinueBody(body: unknown, assistantContent: unknown, toolResult: string, toolId: string): unknown;
  abstract getSettings(): AgentSettings;
}
