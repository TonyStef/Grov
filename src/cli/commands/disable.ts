// grov disable - Remove proxy/MCP configuration

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getAgentByName } from '../../integrations/proxy/agents/index.js';
import { removeProjectRulesPointer } from '../../integrations/mcp/clients/cursor/rules-installer.js';

export async function disable(agentName: 'claude' | 'codex' | 'cursor' | 'antigravity' | 'zed' = 'claude'): Promise<void> {
  // Cursor: MCP-based disable
  if (agentName === 'cursor') {
    console.log('Disabling grov for Cursor...\n');

    // 1. Remove MCP registration (global)
    const mcpResult = removeCursorMcp();

    // 2. Remove stop hook (global)
    const hooksResult = removeCursorHooks();

    // 3. Remove project rules pointer (keeps .grov/)
    const projectDir = process.cwd();
    const pointerRemoved = removeProjectRulesPointer(projectDir);

    if (mcpResult) {
      console.log('  - MCP server unregistered');
    } else {
      console.log('  = MCP server was not registered');
    }

    if (hooksResult) {
      console.log('  - Stop hook removed');
    } else {
      console.log('  = Stop hook was not configured');
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

  // Antigravity: MCP-based disable
  if (agentName === 'antigravity') {
    console.log('Disabling grov for Antigravity...\n');

    const mcpResult = removeAntigravityMcp();

    if (mcpResult) {
      console.log('  - MCP server unregistered');
    } else {
      console.log('  = MCP server was not registered');
    }

    console.log('\nRestart Antigravity to apply changes.');
    return;
  }

  // Zed: MCP-based disable
  if (agentName === 'zed') {
    console.log('Disabling grov for Zed...\n');

    const mcpResult = removeZedMcp();

    if (mcpResult) {
      console.log('  - Context server unregistered');
    } else {
      console.log('  = Context server was not registered');
    }

    console.log('\nRestart Zed to apply changes.');
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

/**
 * Remove grov hook from ~/.cursor/hooks.json
 */
function removeCursorHooks(): boolean {
  const hooksPath = join(homedir(), '.cursor', 'hooks.json');

  if (!existsSync(hooksPath)) {
    return false;
  }

  try {
    const content = readFileSync(hooksPath, 'utf-8');
    const config = JSON.parse(content) as { hooks?: { stop?: Array<{ command?: string }> } };

    if (!config.hooks?.stop) {
      return false;
    }

    const originalLength = config.hooks.stop.length;
    config.hooks.stop = config.hooks.stop.filter(
      (h) => !h.command?.includes('grov capture-hook')
    );

    if (config.hooks.stop.length === originalLength) {
      return false;
    }

    writeFileSync(hooksPath, JSON.stringify(config, null, 2));
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove grov MCP from ~/.gemini/antigravity/mcp_config.json
 */
function removeAntigravityMcp(): boolean {
  const mcpConfigPath = join(homedir(), '.gemini', 'antigravity', 'mcp_config.json');

  if (!existsSync(mcpConfigPath)) {
    return false;
  }

  try {
    const content = readFileSync(mcpConfigPath, 'utf-8');
    const config = JSON.parse(content) as { mcpServers?: Record<string, unknown> };

    if (!config.mcpServers?.grov) {
      return false;
    }

    delete config.mcpServers.grov;
    writeFileSync(mcpConfigPath, JSON.stringify(config, null, 2));
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove grov from ~/.config/zed/settings.json context_servers
 */
function removeZedMcp(): boolean {
  const settingsPath = join(homedir(), '.config', 'zed', 'settings.json');

  if (!existsSync(settingsPath)) {
    return false;
  }

  try {
    const content = readFileSync(settingsPath, 'utf-8');
    // Remove comments for parsing
    const cleanContent = content.replace(/^\s*\/\/.*$/gm, '');
    const config = JSON.parse(cleanContent) as { context_servers?: Record<string, unknown> };

    if (!config.context_servers?.grov) {
      return false;
    }

    delete config.context_servers.grov;
    writeFileSync(settingsPath, JSON.stringify(config, null, 2));
    return true;
  } catch {
    return false;
  }
}
