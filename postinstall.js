#!/usr/bin/env node

// Postinstall script for grov
// 1. Triggers device flow login
// 2. Configures Cursor MCP if ~/.cursor/ exists

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));

const green = '\x1b[32m';
const cyan = '\x1b[36m';
const yellow = '\x1b[33m';
const dim = '\x1b[2m';
const reset = '\x1b[0m';
const bold = '\x1b[1m';

console.log(`
${green}✓${reset} ${bold}grov installed successfully${reset}
`);

// ─────────────────────────────────────────────────────────────
// Step 1: Run login flow
// ─────────────────────────────────────────────────────────────

async function runLogin() {
  return new Promise((resolve) => {
    const cliPath = join(__dirname, 'dist', 'cli', 'index.js');

    // Check if dist exists (it should, since we publish built package)
    if (!existsSync(cliPath)) {
      console.log(`${yellow}⚠${reset} Build not found. Run ${cyan}grov login${reset} after installation.`);
      resolve(false);
      return;
    }

    console.log(`${dim}Starting authentication...${reset}\n`);

    const child = spawn('node', [cliPath, 'login'], {
      stdio: 'inherit',
      cwd: __dirname,
    });

    child.on('close', (code) => {
      resolve(code === 0);
    });

    child.on('error', (err) => {
      console.log(`${yellow}⚠${reset} Could not start login: ${err.message}`);
      console.log(`Run ${cyan}grov login${reset} manually after installation.\n`);
      resolve(false);
    });
  });
}

// ─────────────────────────────────────────────────────────────
// Step 2: Configure Cursor MCP
// ─────────────────────────────────────────────────────────────

function configureCursorMcp() {
  const cursorDir = join(homedir(), '.cursor');
  const mcpPath = join(cursorDir, 'mcp.json');

  // Check if Cursor is installed
  if (!existsSync(cursorDir)) {
    console.log(`${dim}Cursor not detected. Skip MCP configuration.${reset}`);
    console.log(`${dim}If you install Cursor later, run: ${cyan}grov setup mcp cursor${reset}\n`);
    return false;
  }

  console.log(`${dim}Configuring Cursor MCP...${reset}`);

  // The grov MCP entry
  const grovMcpEntry = {
    command: 'grov',
    args: ['mcp'],
  };

  let mcpConfig = { mcpServers: {} };

  // Read existing mcp.json if it exists
  if (existsSync(mcpPath)) {
    try {
      const content = readFileSync(mcpPath, 'utf-8');
      mcpConfig = JSON.parse(content);

      // Ensure mcpServers object exists
      if (!mcpConfig.mcpServers) {
        mcpConfig.mcpServers = {};
      }
    } catch (err) {
      console.log(`${yellow}⚠${reset} Could not parse ${mcpPath}, creating new config.`);
      mcpConfig = { mcpServers: {} };
    }
  }

  // Check if grov is already configured
  if (mcpConfig.mcpServers.grov) {
    console.log(`${green}✓${reset} Cursor MCP already configured for grov.`);
    return true;
  }

  // Add grov entry
  mcpConfig.mcpServers.grov = grovMcpEntry;

  // Write back
  try {
    writeFileSync(mcpPath, JSON.stringify(mcpConfig, null, 2));
    console.log(`${green}✓${reset} Cursor MCP configured.`);
    console.log(`${dim}  Restart Cursor to activate grov MCP server.${reset}\n`);
    return true;
  } catch (err) {
    console.log(`${yellow}⚠${reset} Could not write ${mcpPath}: ${err.message}`);
    console.log(`${dim}Run ${cyan}grov setup mcp cursor${reset} to configure manually.\n`);
    return false;
  }
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────

async function main() {
  // Run login (interactive)
  const loginSuccess = await runLogin();

  if (loginSuccess) {
    console.log('');
  }

  // Configure Cursor MCP
  configureCursorMcp();

  // Final message
  console.log(`${dim}Quick commands:${reset}`);
  console.log(`  ${green}grov status${reset}      Check sync status`);
  console.log(`  ${green}grov doctor${reset}      Verify setup`);
  console.log(`  ${green}grov proxy${reset}       Start Claude Code proxy`);
  console.log(`
${dim}Dashboard:${reset} ${cyan}https://app.grov.dev${reset}
`);
}

main().catch((err) => {
  console.error('Postinstall error:', err);
  process.exit(0); // Don't fail install on postinstall errors
});
