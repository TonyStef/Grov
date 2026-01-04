// grov agents - List supported agents and setup instructions

import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { parse } from 'smol-toml';

const CLAUDE_SETTINGS_PATH = join(homedir(), '.claude', 'settings.json');
const CODEX_CONFIG_PATH = join(homedir(), '.codex', 'config.toml');
const CURSOR_MCP_PATH = join(homedir(), '.cursor', 'mcp.json');

interface Agent {
  name: string;
  description: string;
  isConfigured: () => boolean;
  setupCommand: string;
  requirements: string[];
}

const AGENTS: Agent[] = [
  {
    name: 'Claude Code',
    description: 'Anthropic Claude Code CLI',
    isConfigured: () => {
      if (!existsSync(CLAUDE_SETTINGS_PATH)) return false;
      try {
        const settings = JSON.parse(readFileSync(CLAUDE_SETTINGS_PATH, 'utf-8'));
        return settings.env?.ANTHROPIC_BASE_URL === 'http://127.0.0.1:8080';
      } catch {
        return false;
      }
    },
    setupCommand: 'grov init claude',
    requirements: ['ANTHROPIC_API_KEY environment variable', 'Claude Code CLI installed (npm i -g @anthropic-ai/claude-code)'],
  },
  {
    name: 'Codex CLI',
    description: 'OpenAI Codex CLI',
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
    setupCommand: 'grov init codex',
    requirements: ['OPENAI_API_KEY environment variable', 'Codex CLI installed (npm i -g @openai/codex)'],
  },
  {
    name: 'Cursor',
    description: 'Cursor IDE (MCP)',
    isConfigured: () => {
      if (!existsSync(CURSOR_MCP_PATH)) return false;
      try {
        const content = readFileSync(CURSOR_MCP_PATH, 'utf-8');
        const config = JSON.parse(content) as { mcpServers?: { grov?: unknown } };
        return !!config.mcpServers?.grov;
      } catch {
        return false;
      }
    },
    setupCommand: 'grov init cursor',
    requirements: ['Cursor IDE installed', 'Run command in project directory'],
  },
];

export function agents(): void {
  console.log('\nSupported Agents');
  console.log('================\n');

  for (const agent of AGENTS) {
    const configured = agent.isConfigured();
    const statusIcon = configured ? '\x1b[32m●\x1b[0m' : '\x1b[90m○\x1b[0m';
    const statusText = configured ? '\x1b[32mConfigured\x1b[0m' : '\x1b[90mNot configured\x1b[0m';

    console.log(`${statusIcon} ${agent.name} - ${agent.description}`);
    console.log(`   Status: ${statusText}`);

    if (!configured) {
      console.log(`   Setup:  ${agent.setupCommand}`);
      console.log('   Requires:');
      for (const req of agent.requirements) {
        console.log(`     • ${req}`);
      }
    }

    console.log('');
  }

  console.log('Quick Start:');
  console.log('  1. Run \x1b[36mgrov init <agent>\x1b[0m to configure your agent');
  console.log('  2. Run \x1b[36mgrov proxy\x1b[0m in a terminal (keep it running)');
  console.log('  3. Use your AI agent normally in another terminal');
  console.log('  4. Grov captures reasoning and syncs to your team\n');
  console.log('Troubleshooting: \x1b[36mgrov doctor <agent>\x1b[0m for detailed checks\n');
}
