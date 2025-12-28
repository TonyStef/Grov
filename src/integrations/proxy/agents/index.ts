// Agent registry - detects and provides agent adapters

import type { FastifyRequest } from 'fastify';
import type { AgentAdapter, AgentName } from './types.js';
import { ClaudeAdapter } from './claude/index.js';
import { CodexAdapter } from './codex/index.js';

const adapters: AgentAdapter[] = [
  new ClaudeAdapter(),
  new CodexAdapter(),
];

export function getAllAgents(): AgentAdapter[] {
  return adapters;
}

export function getAgentForRequest(request: FastifyRequest): AgentAdapter | undefined {
  return adapters.find(adapter => adapter.canHandle(request));
}

export function getAgentByName(name: AgentName): AgentAdapter | undefined {
  return adapters.find(adapter => adapter.name === name);
}

export function getAgentByEndpoint(endpoint: string): AgentAdapter | undefined {
  return adapters.find(adapter => adapter.endpoint === endpoint);
}

export function getSupportedEndpoints(): string[] {
  return adapters.map(adapter => adapter.endpoint);
}

export { ClaudeAdapter } from './claude/index.js';
export { CodexAdapter } from './codex/index.js';
export { BaseAdapter } from './base.js';
export type {
  AgentAdapter,
  AgentName,
  AgentSettings,
  NormalizedAction,
  ForwardResult,
  TokenUsage,
  ToolUseBlock,
} from './types.js';
