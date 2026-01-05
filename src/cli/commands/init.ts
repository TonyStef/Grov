// grov init - Configure AI agent to use grov proxy/MCP

import type { AgentName } from '../../integrations/proxy/agents/types.js';
import { getAgentByName } from '../../integrations/proxy/agents/index.js';
import { setupMcpCursor, setupMcpAntigravity, setupMcpZed } from './setup.js';
import { installProjectRules } from '../../integrations/mcp/clients/cursor/rules-installer.js';

interface AgentInstructions {
  envVar: string;
  command: string;
  keyUrl: string;
}

const AGENT_INSTRUCTIONS: Record<'claude' | 'codex', AgentInstructions> = {
  claude: {
    envVar: 'ANTHROPIC_API_KEY',
    command: 'claude',
    keyUrl: 'https://console.anthropic.com/settings/keys',
  },
  codex: {
    envVar: 'OPENAI_API_KEY',
    command: 'codex',
    keyUrl: 'https://platform.openai.com/api-keys',
  },
};

export async function init(agentName: 'claude' | 'codex' | 'cursor' | 'antigravity' | 'zed' = 'claude'): Promise<void> {
  // Cursor: MCP-based setup (different from proxy)
  if (agentName === 'cursor') {
    console.log('Configuring grov for Cursor...\n');

    // 1. MCP registration (global)
    await setupMcpCursor();

    // 2. Project rules (per-project)
    const projectDir = process.cwd();
    const result = installProjectRules(projectDir);

    if (result.grovRules) {
      console.log('  + Created .grov/rules.mdc');
    } else {
      console.log('  = .grov/rules.mdc already exists');
    }

    if (result.cursorPointer) {
      console.log('  + Created .cursor/rules/90_grov.mdc');
    } else {
      console.log('  = .cursor/rules/90_grov.mdc already exists');
    }

    console.log('\n--- Next Steps ---');
    console.log('1. Restart Cursor');
    console.log('2. Open this project in Cursor');
    console.log('\nRun "grov doctor cursor" to verify setup.');
    return;
  }

  // Antigravity: MCP-based setup
  if (agentName === 'antigravity') {
    console.log('Configuring grov for Antigravity...\n');

    // MCP registration (global)
    await setupMcpAntigravity();

    console.log('\n--- Next Steps ---');
    console.log('1. Restart Antigravity');
    console.log('2. Open your project in Antigravity');
    console.log('\nRun "grov doctor antigravity" to verify setup.');
    return;
  }

  // Zed: MCP-based setup
  if (agentName === 'zed') {
    console.log('Configuring grov for Zed...\n');

    // MCP registration (global)
    await setupMcpZed();

    console.log('\n--- Next Steps ---');
    console.log('1. Restart Zed');
    console.log('2. Open the Agent Panel in Zed');
    console.log('\nRun "grov doctor zed" to verify setup.');
    return;
  }

  // Claude/Codex: proxy-based setup
  const agent = getAgentByName(agentName);
  if (!agent) {
    console.error(`Unknown agent: ${agentName}`);
    console.error('Supported agents: claude, codex, cursor');
    process.exit(1);
  }

  const instructions = AGENT_INSTRUCTIONS[agentName];
  console.log(`Configuring grov for ${agentName}...\n`);

  const settings = agent.getSettings();
  const result = settings.setProxyEnabled(true);

  if (result.action === 'added') {
    console.log(`  + Proxy configured for ${agentName}`);
  } else if (result.action === 'unchanged') {
    console.log(`  = Proxy already configured for ${agentName}`);
  }

  console.log(`\nConfig file: ${settings.getConfigPath()}`);

  console.log('\n--- Next Steps (Claude/Codex) ---');
  console.log('1. Terminal 1: grov proxy');
  console.log(`2. Terminal 2: ${instructions.command}`);
  console.log('\nRun "grov doctor" to verify your setup is complete.');
}
