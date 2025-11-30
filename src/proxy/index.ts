// Grov Proxy CLI entry point

// Load .env file for API keys
import { config } from 'dotenv';
config();

import { startServer } from './server.js';

startServer().catch((err) => {
  console.error('✗ Proxy failed:', err);
  process.exit(1);
});
