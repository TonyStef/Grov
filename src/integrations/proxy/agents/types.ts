// Agent adapter types for multi-agent proxy support

import type { FastifyRequest } from 'fastify';
import type { StepActionType } from '../../../core/store/store.js';

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
}

export interface AgentSettings {
  getConfigPath(): string;
  setProxyEnabled(enabled: boolean): { action: 'added' | 'removed' | 'unchanged' };
}

export interface AgentAdapter {
  readonly name: AgentName;
  readonly endpoint: string;

  canHandle(request: FastifyRequest): boolean;
  extractProjectPath(body: unknown): string | null;
  extractSessionId(response: unknown): string | null;
  forward(body: unknown, headers: Record<string, string>): Promise<ForwardResult>;
  parseActions(response: unknown): NormalizedAction[];
  injectMemory(body: unknown, memory: string): unknown;
  injectDelta(body: unknown, delta: string): unknown;
  getSettings(): AgentSettings;
}
