// Centralized agent registry for CLI operations
// Add new agents here - all CLI commands will see them

import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { parse } from 'smol-toml';

export type AgentType = 'cli' | 'ide';

export interface CliAgent {
  id: string;
  name: string;
  description: string;
  type: AgentType;
  command: string;
  requirements: string[];
  configPath: string;
  isConfigured: () => boolean;
}

const CLAUDE_SETTINGS_PATH = join(homedir(), '.claude', 'settings.json');
const CODEX_CONFIG_PATH = join(homedir(), '.codex', 'config.toml');
const CURSOR_MCP_PATH = join(homedir(), '.cursor', 'mcp.json');
const ZED_SETTINGS_PATH = join(homedir(), '.config', 'zed', 'settings.json');

const AGENTS: CliAgent[] = [
  {
    id: 'claude',
    name: 'Claude Code',
    description: "Anthropic's coding agent",
    type: 'cli',
    command: 'claude',
    requirements: ['Claude Code CLI (npm i -g @anthropic-ai/claude-code)'],
    configPath: CLAUDE_SETTINGS_PATH,
    isConfigured: () => {
      if (!existsSync(CLAUDE_SETTINGS_PATH)) return false;
      try {
        const settings = JSON.parse(readFileSync(CLAUDE_SETTINGS_PATH, 'utf-8'));
        return settings.env?.ANTHROPIC_BASE_URL === 'http://127.0.0.1:8080';
      } catch {
        return false;
      }
    },
  },
  {
    id: 'codex',
    name: 'Codex',
    description: "OpenAI's CLI agent",
    type: 'cli',
    command: 'codex',
    requirements: ['OPENAI_API_KEY environment variable', 'Codex CLI (npm i -g @openai/codex)'],
    configPath: CODEX_CONFIG_PATH,
    isConfigured: () => {
      if (!existsSync(CODEX_CONFIG_PATH)) return false;
      try {
        const content = readFileSync(CODEX_CONFIG_PATH, 'utf-8');
        const config = parse(content) as { model_provider?: string; model_providers?: { grov?: unknown } };
        return config.model_provider === 'grov' && !!config.model_providers?.grov;
      } catch {
        return false;
      }
    },
  },
  {
    id: 'cursor',
    name: 'Cursor',
    description: 'Cursor IDE',
    type: 'ide',
    command: 'cursor',
    requirements: ['Cursor IDE installed'],
    configPath: CURSOR_MCP_PATH,
    isConfigured: () => {
      if (!existsSync(CURSOR_MCP_PATH)) return false;
      try {
        const config = JSON.parse(readFileSync(CURSOR_MCP_PATH, 'utf-8')) as { mcpServers?: { grov?: unknown } };
        return !!config.mcpServers?.grov;
      } catch {
        return false;
      }
    },
  },
  {
    id: 'zed',
    name: 'Zed',
    description: 'Zed Editor',
    type: 'ide',
    command: 'zed',
    requirements: ['Zed Editor installed'],
    configPath: ZED_SETTINGS_PATH,
    isConfigured: () => {
      if (!existsSync(ZED_SETTINGS_PATH)) return false;
      try {
        const config = JSON.parse(readFileSync(ZED_SETTINGS_PATH, 'utf-8')) as { context_servers?: { grov?: unknown } };
        return !!config.context_servers?.grov;
      } catch {
        return false;
      }
    },
  },
];

export function getAllCliAgents(): CliAgent[] {
  return AGENTS;
}

export function getCliAgentsByType(type: AgentType): CliAgent[] {
  return AGENTS.filter(a => a.type === type);
}

export function getCliAgentById(id: string): CliAgent | undefined {
  return AGENTS.find(a => a.id === id);
}

export function isAnyAgentConfigured(): boolean {
  return AGENTS.some(a => a.isConfigured());
}

export function getConfiguredAgents(): CliAgent[] {
  return AGENTS.filter(a => a.isConfigured());
}

export function getFirstConfiguredAgent(): CliAgent | null {
  return AGENTS.find(a => a.isConfigured()) ?? null;
}
