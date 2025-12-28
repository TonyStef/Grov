// Agent adapter types for multi-agent proxy support

import type { FastifyRequest } from 'fastify';
import type { StepActionType } from '../../../core/store/store.js';
import type { ConversationMessage } from '../../../core/extraction/llm-extractor.js';

export type AgentName = 'claude' | 'codex' | 'gemini';

export interface NormalizedAction {
  toolName: string;
  actionType: StepActionType;
  sourceAgent: AgentName;
  files: string[];
  folders: string[];
  command?: string;
  rawInput: unknown;
}

export interface ForwardResult {
  statusCode: number;
  headers: Record<string, string>;
  body: unknown;
  rawBody: string;
  wasSSE?: boolean;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheCreation: number;
  cacheRead: number;
}

export interface ToolUseBlock {
  id: string;
  name: string;
  input: unknown;
}

export interface AgentSettings {
  getConfigPath(): string;
  setProxyEnabled(enabled: boolean): { action: 'added' | 'removed' | 'unchanged' };
}

export interface AgentAdapter {
  readonly name: AgentName;
  readonly endpoint: string;

  canHandle(request: FastifyRequest): boolean;

  forward(
    body: unknown,
    headers: Record<string, string>,
    rawBody?: Buffer
  ): Promise<ForwardResult>;

  extractProjectPath(body: unknown): string | null;
  extractSessionId(response: unknown): string | null;
  extractTextContent(response: unknown): string;
  extractGoal(messages: unknown[]): string;
  extractHistory(messages: unknown[]): ConversationMessage[];
  extractUsage(response: unknown): TokenUsage;

  isValidResponse(body: unknown): boolean;
  isSubagentModel(model: string): boolean;
  isEndTurn(response: unknown): boolean;
  isToolUse(response: unknown): boolean;

  parseActions(response: unknown): NormalizedAction[];
  getToolUseBlocks(response: unknown): ToolUseBlock[];
  findInternalToolUse(response: unknown, toolName: string): ToolUseBlock | null;

  injectMemory(body: unknown, memory: string): unknown;
  injectDelta(body: unknown, delta: string): unknown;
  injectTool(body: unknown, toolDef: unknown): unknown;

  filterResponseHeaders(headers: Record<string, string | string[]>): Record<string, string>;
  buildContinueBody(
    body: unknown,
    assistantContent: unknown,
    toolResult: string,
    toolId: string
  ): unknown;
  getResponseContentType(wasSSE: boolean): string;

  getSettings(): AgentSettings;
}
