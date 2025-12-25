// grov uninstall - Full cleanup and removal

import { rmSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import * as readline from 'readline';
import { setProxyEnv } from '../../integrations/proxy/agents/claude/settings.js';
import { clearCredentials } from '../../core/cloud/credentials.js';

const GROV_DIR = join(homedir(), '.grov');

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

export async function uninstall(): Promise<void> {
  console.log('\nGrov Uninstall');
  console.log('==============\n');

  console.log('This will remove:');
  console.log('  - Proxy config from ~/.claude/settings.json (ANTHROPIC_BASE_URL only)');
  console.log('  - Login credentials (~/.grov/credentials.json)');
  console.log('  - Local database (~/.grov/memory.db)');
  console.log('  - All files in ~/.grov/\n');

  const confirm = await prompt('Continue? [y/N]: ');
  if (confirm !== 'y' && confirm !== 'yes') {
    console.log('Cancelled.\n');
    return;
  }

  // Remove proxy config from Claude settings
  const result = setProxyEnv(false);
  if (result.action === 'removed') {
    console.log('✓ Removed proxy config from Claude settings');
  }

  // Clear credentials
  clearCredentials();
  console.log('✓ Cleared login credentials');

  // Remove ~/.grov folder
  if (existsSync(GROV_DIR)) {
    rmSync(GROV_DIR, { recursive: true, force: true });
    console.log('✓ Removed ~/.grov folder (database, logs)');
  }

  console.log('\nGrov data removed. To complete uninstall, run:');
  console.log('  npm uninstall -g grov\n');
}
