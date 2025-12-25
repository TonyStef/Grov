// Setup commands for grov integrations

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

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
