#!/usr/bin/env node

// Postinstall script for grov
// Triggers device flow login

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';

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

    const child = spawn('node', [cliPath, 'login', '--auto'], {
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

async function main() {
  // Run login (interactive)
  const loginSuccess = await runLogin();

  if (loginSuccess) {
    console.log('');
  }

  // Final message
  console.log(`${dim}Quick commands:${reset}`);
  console.log(`  ${green}grov status${reset}      Check sync status`);
  console.log(`  ${green}grov doctor${reset}      Verify setup`);
  console.log(`  ${green}grov agents${reset}      List supported agents`);
  console.log(`
${dim}Dashboard:${reset} ${cyan}https://app.grov.dev${reset}
`);
}

main().catch((err) => {
  console.error('Postinstall error:', err);
  process.exit(0); // Don't fail install on postinstall errors
});
