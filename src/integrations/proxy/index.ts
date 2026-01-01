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

// Note: Claude Code auth comes from request headers (no env var needed)
// Env loading above is for Codex future use and CLI tools

startServer().catch((err) => {
  console.error('Proxy failed:', err);
  process.exit(1);
});
