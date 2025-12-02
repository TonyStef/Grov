// Grov Proxy CLI entry point

// Load .env file for API keys
import { config } from 'dotenv';
import { join } from 'path';
import { homedir } from 'os';
import { existsSync } from 'fs';

// Load from current directory .env first
config();

// Also load ~/.grov/.env as fallback
const grovEnvPath = join(homedir(), '.grov', '.env');
if (existsSync(grovEnvPath)) {
  config({ path: grovEnvPath });
}

import { startServer } from './server.js';

// Check for API key before starting proxy
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('Error: ANTHROPIC_API_KEY is required to run the proxy.\n');
  console.error('To set it up:\n');
  console.error('  1. Get your API key at:');
  console.error('     https://console.anthropic.com/settings/keys\n');
  console.error('  2. Add to ~/.zshrc (or ~/.bashrc):');
  console.error('     export ANTHROPIC_API_KEY=sk-ant-...\n');
  console.error('  3. Restart terminal or run: source ~/.zshrc\n');
  console.error('Then try again: grov proxy');
  process.exit(1);
}

startServer().catch((err) => {
  console.error('Proxy failed:', err);
  process.exit(1);
});
