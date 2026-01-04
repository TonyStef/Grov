// grov init - Configure AI agent to use grov proxy/MCP

import type { AgentName } from '../../integrations/proxy/agents/types.js';
import { getAgentByName } from '../../integrations/proxy/agents/index.js';
import { setupMcpCursor } from './setup.js';
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

export async function init(agentName: 'claude' | 'codex' | 'cursor' = 'claude'): Promise<void> {
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

  // Claude Code: no API key needed (auth comes from request headers)
  // Codex: needs OPENAI_API_KEY for main requests
  if (agentName === 'codex') {
    const isWindows = process.platform === 'win32';
    const shell = process.env.SHELL?.includes('zsh') ? '~/.zshrc' : '~/.bashrc';

    if (!process.env[instructions.envVar]) {
      console.log('\n╔═══════════════════════════════════════════════════════════╗');
      console.log(`║  ⚠️  ${instructions.envVar} NOT SET                              ║`);
      console.log('╚═══════════════════════════════════════════════════════════╝');
      console.log('\n  1. Get your API key at:');
      console.log(`     ${instructions.keyUrl}\n`);

      if (isWindows) {
        console.log('  2. Set PERMANENTLY (run in Command Prompt as Admin):');
        console.log(`     setx ${instructions.envVar} "your-key-here"\n`);
        console.log('  3. Restart your terminal\n');
      } else {
        console.log('  2. Add PERMANENTLY to your shell:');
        console.log(`     echo 'export ${instructions.envVar}=your-key-here' >> ${shell}\n`);
        console.log('  3. Apply changes:');
        console.log(`     source ${shell}\n`);
      }
    } else {
      console.log(`\n  ✓ ${instructions.envVar} found`);
    }
  }

  console.log('\n--- Next Steps (Claude/Codex) ---');
  console.log('1. Terminal 1: grov proxy');
  console.log(`2. Terminal 2: ${instructions.command}`);
  console.log('\nRun "grov doctor" to verify your setup is complete.');
}
