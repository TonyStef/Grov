// Setup commands for grov integrations

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import * as readline from 'readline';
import { getCliAgentsByType, isAnyAgentConfigured } from '../agents/registry.js';
import type { CliAgent } from '../agents/registry.js';

const green = '\x1b[32m';
const yellow = '\x1b[33m';
const cyan = '\x1b[36m';
const dim = '\x1b[2m';
const reset = '\x1b[0m';

export async function setupMcpCursor(): Promise<void> {
  const cursorDir = join(homedir(), '.cursor');
  const mcpPath = join(cursorDir, 'mcp.json');

  // Check if Cursor directory exists
  if (!existsSync(cursorDir)) {
    console.log(`${yellow}⚠${reset} Cursor not installed (~/.cursor not found)`);
    console.log(`${dim}Install Cursor first, then run this command again.${reset}\n`);
    return;
  }

  const grovEntry = {
    command: 'grov',
    args: ['mcp'],
  };

  let mcpConfig: { mcpServers?: Record<string, unknown> } = { mcpServers: {} };

  // Read existing config
  if (existsSync(mcpPath)) {
    try {
      const content = readFileSync(mcpPath, 'utf-8');
      mcpConfig = JSON.parse(content);
      if (!mcpConfig.mcpServers) {
        mcpConfig.mcpServers = {};
      }
    } catch {
      console.log(`${yellow}⚠${reset} Could not parse ${mcpPath}, creating new config.`);
      mcpConfig = { mcpServers: {} };
    }
  }

  // Check if already configured
  if (mcpConfig.mcpServers?.grov) {
    console.log(`${green}✓${reset} Cursor MCP already configured for grov.`);
    console.log(`${dim}Restart Cursor to apply any changes.${reset}\n`);
    return;
  }

  // Add grov entry
  mcpConfig.mcpServers!.grov = grovEntry;

  // Write config
  try {
    writeFileSync(mcpPath, JSON.stringify(mcpConfig, null, 2));
    console.log(`${green}✓${reset} Cursor MCP configured.`);
    console.log(`${dim}Restart Cursor to activate grov.${reset}\n`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.error(`${yellow}⚠${reset} Could not write ${mcpPath}: ${msg}`);
  }
}

export async function setupMcpAntigravity(): Promise<void> {
  const antigravityDir = join(homedir(), '.gemini', 'antigravity');
  const mcpConfigPath = join(antigravityDir, 'mcp_config.json');

  // Check if Antigravity directory exists
  if (!existsSync(antigravityDir)) {
    console.log(`${yellow}⚠${reset} Antigravity not installed (~/.gemini/antigravity not found)`);
    console.log(`${dim}Install Antigravity first, then run this command again.${reset}\n`);
    return;
  }

  const grovEntry = {
    command: 'grov',
    args: ['mcp'],
  };

  let config: { mcpServers?: Record<string, unknown> } = { mcpServers: {} };

  // Read existing config
  if (existsSync(mcpConfigPath)) {
    try {
      const content = readFileSync(mcpConfigPath, 'utf-8');
      config = JSON.parse(content);
      if (!config.mcpServers) {
        config.mcpServers = {};
      }
    } catch {
      console.log(`${yellow}⚠${reset} Could not parse ${mcpConfigPath}, creating new config.`);
      config = { mcpServers: {} };
    }
  }

  // Check if already configured
  if (config.mcpServers?.grov) {
    console.log(`${green}✓${reset} Antigravity MCP already configured for grov.`);
    console.log(`${dim}Restart Antigravity to apply any changes.${reset}\n`);
    return;
  }

  // Add grov entry
  config.mcpServers!.grov = grovEntry;

  // Write config
  try {
    writeFileSync(mcpConfigPath, JSON.stringify(config, null, 2));
    console.log(`${green}✓${reset} Antigravity MCP configured.`);
    console.log(`${dim}Restart Antigravity to activate grov.${reset}\n`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.error(`${yellow}⚠${reset} Could not write ${mcpConfigPath}: ${msg}`);
  }
}

export async function setupMcpZed(): Promise<void> {
  const zedConfigDir = join(homedir(), '.config', 'zed');
  const settingsPath = join(zedConfigDir, 'settings.json');

  // Check if Zed config directory exists
  if (!existsSync(zedConfigDir)) {
    console.log(`${yellow}⚠${reset} Zed not installed (~/.config/zed not found)`);
    console.log(`${dim}Install Zed first, then run this command again.${reset}\n`);
    return;
  }

  const grovEntry = {
    command: 'grov',
    args: ['mcp'],
  };

  let config: Record<string, unknown> = {};

  // Read existing config (preserve all settings)
  if (existsSync(settingsPath)) {
    try {
      // Zed settings.json may have comments, try to parse anyway
      const content = readFileSync(settingsPath, 'utf-8');
      // Remove single-line comments for parsing
      const cleanContent = content.replace(/^\s*\/\/.*$/gm, '');
      config = JSON.parse(cleanContent);
    } catch {
      console.log(`${yellow}⚠${reset} Could not parse ${settingsPath}. Please add grov manually.`);
      console.log(`\nAdd to your settings.json under "context_servers":`);
      console.log(`  "grov": { "command": "grov", "args": ["mcp"] }\n`);
      return;
    }
  }

  // Ensure context_servers object exists
  if (!config.context_servers) {
    config.context_servers = {};
  }

  const contextServers = config.context_servers as Record<string, unknown>;

  // Check if already configured
  if (contextServers.grov) {
    console.log(`${green}✓${reset} Zed context_servers already configured for grov.`);
    console.log(`${dim}Restart Zed to apply any changes.${reset}\n`);
    return;
  }

  // Add grov entry
  contextServers.grov = grovEntry;

  // Write config
  try {
    writeFileSync(settingsPath, JSON.stringify(config, null, 2));
    console.log(`${green}✓${reset} Zed context_servers configured.`);
    console.log(`${dim}Restart Zed to activate grov.${reset}\n`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.error(`${yellow}⚠${reset} Could not write ${settingsPath}: ${msg}`);
  }
}

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export async function runAgentSetup(): Promise<void> {
  const cliAgents = getCliAgentsByType('cli');
  const ideAgents = getCliAgentsByType('ide');
  const allAgents = [...cliAgents, ...ideAgents];

  console.log('What AI tool do you use?\n');

  console.log('CLI AGENTS (require proxy running)');
  cliAgents.forEach((agent, i) => {
    console.log(`  ${i + 1}. ${agent.name} - ${agent.description}`);
  });

  console.log('\nIDE AGENTS (native integration, no proxy)');
  ideAgents.forEach((agent, i) => {
    console.log(`  ${cliAgents.length + i + 1}. ${agent.name} - ${agent.description}`);
  });

  const choice = await prompt(`\nSelect agent [1-${allAgents.length}]: `);
  const index = parseInt(choice, 10) - 1;

  if (index < 0 || index >= allAgents.length || isNaN(index)) {
    console.log('\nInvalid selection. Run "grov setup" to try again.\n');
    return;
  }

  const selectedAgent = allAgents[index];
  await configureAgent(selectedAgent);
  showFinalInstructions(selectedAgent);
}

async function configureAgent(agent: CliAgent): Promise<void> {
  console.log(`\nConfiguring ${agent.name}...\n`);

  const { init } = await import('./init.js');
  await init(agent.id as 'claude' | 'codex' | 'cursor');
}

function showFinalInstructions(agent: CliAgent): void {
  console.log('\n╔═════════════════════════════════════════════════════════╗');
  console.log('║                                                         ║');
  console.log('║   ✓ Setup complete!                                     ║');
  console.log('║                                                         ║');
  console.log('╚═════════════════════════════════════════════════════════╝\n');

  if (agent.type === 'cli') {
    console.log('┌─────────────────────────────────────────────────────┐');
    console.log('│  HOW TO USE GROV                                    │');
    console.log('│                                                     │');
    console.log('│  1. Start proxy (keep running):                     │');
    console.log('│     $ grov proxy                                    │');
    console.log('│                                                     │');
    console.log('│  2. In another terminal, use your agent:            │');
    console.log(`│     $ ${agent.command}`.padEnd(54) + '│');
    console.log('│                                                     │');
    console.log('│  3. View your team\'s memories:                      │');
    console.log('│     https://app.grov.dev                            │');
    console.log('└─────────────────────────────────────────────────────┘');
  } else {
    console.log('┌─────────────────────────────────────────────────────┐');
    console.log('│  HOW TO USE GROV                                    │');
    console.log('│                                                     │');
    console.log(`│  1. Restart ${agent.name}`.padEnd(54) + '│');
    console.log('│                                                     │');
    console.log(`│  2. Use ${agent.name} normally`.padEnd(54) + '│');
    console.log('│     Grov runs automatically in the background       │');
    console.log('│                                                     │');
    console.log('│  3. View your team\'s memories:                      │');
    console.log('│     https://app.grov.dev                            │');
    console.log('└─────────────────────────────────────────────────────┘');
  }

  console.log('\nTip: Run "grov doctor" anytime to check status\n');
}

export async function setup(): Promise<void> {
  const { isAuthenticated } = await import('../../core/cloud/credentials.js');

  if (!isAuthenticated()) {
    console.log('Let\'s get you set up with Grov.\n');
    console.log('First, we\'ll connect to your team...\n');

    const { login } = await import('./login.js');
    await login();
    return;
  }

  if (isAnyAgentConfigured()) {
    console.log('An agent is already configured.\n');
    const reconfigure = await prompt('Reconfigure? [y/N]: ');
    if (reconfigure.toLowerCase() !== 'y' && reconfigure.toLowerCase() !== 'yes') {
      console.log('\nRun "grov doctor" to check your setup.\n');
      return;
    }
  }

  await runAgentSetup();
}
