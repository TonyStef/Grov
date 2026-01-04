// grov disable - Remove proxy/MCP configuration

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getAgentByName } from '../../integrations/proxy/agents/index.js';
import { removeProjectRulesPointer } from '../../integrations/mcp/clients/cursor/rules-installer.js';

export async function disable(agentName: 'claude' | 'codex' | 'cursor' = 'claude'): Promise<void> {
  // Cursor: MCP-based disable
  if (agentName === 'cursor') {
    console.log('Disabling grov for Cursor...\n');

    // 1. Remove MCP registration (global)
    const mcpResult = removeCursorMcp();

    // 2. Remove project rules pointer (keeps .grov/)
    const projectDir = process.cwd();
    const pointerRemoved = removeProjectRulesPointer(projectDir);

    if (mcpResult) {
      console.log('  - MCP server unregistered');
    } else {
      console.log('  = MCP server was not registered');
    }

    if (pointerRemoved) {
      console.log('  - Removed .cursor/rules/90_grov.mdc');
    } else {
      console.log('  = .cursor/rules/90_grov.mdc was not present');
    }

    console.log('\n.grov/ folder preserved (contains your rules).');
    console.log('Restart Cursor to apply changes.');
    return;
  }

  // Claude/Codex: proxy-based disable
  const agent = getAgentByName(agentName);
  if (!agent) {
    console.error(`Unknown agent: ${agentName}`);
    console.error('Supported agents: claude, codex, cursor');
    process.exit(1);
  }

  const settings = agent.getSettings();
  const result = settings.setProxyEnabled(false);

  if (result.action === 'removed') {
    console.log(`Grov disabled for ${agentName}.`);
    console.log('  - Proxy configuration removed');
  } else {
    console.log(`Grov was not configured for ${agentName}.`);
  }

  console.log(`\nConfig file: ${settings.getConfigPath()}`);

  const targetName = agentName === 'claude' ? 'Anthropic' : 'OpenAI';
  console.log(`\n${agentName} will now connect directly to ${targetName}.`);
}

/**
 * Remove grov MCP from ~/.cursor/mcp.json
 */
function removeCursorMcp(): boolean {
  const mcpPath = join(homedir(), '.cursor', 'mcp.json');

  if (!existsSync(mcpPath)) {
    return false;
  }

  try {
    const content = readFileSync(mcpPath, 'utf-8');
    const config = JSON.parse(content) as { mcpServers?: Record<string, unknown> };

    if (!config.mcpServers?.grov) {
      return false;
    }

    delete config.mcpServers.grov;
    writeFileSync(mcpPath, JSON.stringify(config, null, 2));
    return true;
  } catch {
    return false;
  }
}
