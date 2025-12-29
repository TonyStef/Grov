#!/usr/bin/env node

import 'dotenv/config';
import { Command } from 'commander';
import { createRequire } from 'module';
import { closeDatabase } from '../core/store/store.js';

const require = createRequire(import.meta.url);
const pkg = require('../../package.json');

// SECURITY: Global error handlers to catch unhandled rejections from dynamic imports
process.on('unhandledRejection', (reason) => {
  console.error('Error:', reason instanceof Error ? reason.message : 'Unknown error');
  closeDatabase();
  process.exit(1);
});

process.on('uncaughtException', (error) => {
  console.error('Error:', error.message);
  closeDatabase();
  process.exit(1);
});

const program = new Command();

/**
 * Wrap async action with error handling and cleanup.
 * Ensures database connections are closed and errors are handled gracefully.
 */
function safeAction<T>(fn: (options: T) => Promise<void>): (options: T) => Promise<void> {
  return async (options: T) => {
    try {
      await fn(options);
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : 'Unknown error');
      process.exit(1);
    } finally {
      closeDatabase();
    }
  };
}

program
  .name('grov')
  .description('Collective AI memory for engineering teams')
  .version(pkg.version);

// grov init - Configure AI agent to use grov proxy
program
  .command('init [agent]')
  .description('Configure AI agent to use grov proxy (claude or codex, defaults to claude)')
  .action(safeAction(async (agent?: string) => {
    const { init } = await import('./commands/init.js');
    const agentName = (agent === 'codex' ? 'codex' : 'claude') as 'claude' | 'codex';
    await init(agentName);
  }));

// grov disable - Remove proxy configuration
program
  .command('disable [agent]')
  .description('Disable grov for AI agent (claude or codex, defaults to claude)')
  .action(safeAction(async (agent?: string) => {
    const { disable } = await import('./commands/disable.js');
    const agentName = (agent === 'codex' ? 'codex' : 'claude') as 'claude' | 'codex';
    await disable(agentName);
  }));

// grov status - Show stored reasoning for current project
program
  .command('status')
  .description('Show stored reasoning for current project')
  .option('--all', 'Show all tasks, not just completed')
  .action(safeAction(async (options: { all?: boolean }) => {
    const { status } = await import('./commands/status.js');
    await status(options);
  }));

// grov drift-test - Test drift detection on a prompt
program
  .command('drift-test')
  .description('Test drift detection on a prompt (debug command)')
  .argument('<prompt>', 'The prompt to test for drift')
  .option('--session <id>', 'Session ID to use for context')
  .option('--goal <text>', 'Original goal (if no session provided)')
  .option('-v, --verbose', 'Show verbose output')
  .action(async (prompt, options) => {
    const { driftTest } = await import('./commands/drift-test.js');
    await driftTest(prompt, options);
  });

// grov proxy - Start the proxy server
program
  .command('proxy')
  .description('Start the Grov proxy server (intercepts Claude API calls)')
  .option('-d, --debug', 'Enable debug logging to grov-proxy.log')
  .option('--extended-cache', 'Keep Anthropic cache alive during idle (sends requests on your behalf)')
  .action(async (options: { debug?: boolean; extendedCache?: boolean }) => {
    if (options.extendedCache) {
      process.env.GROV_EXTENDED_CACHE = 'true';
      console.log('\n⚠️  Extended Cache Enabled');
      console.log('   By using --extended-cache, you consent to Grov making');
      console.log('   minimal keep-alive requests on your behalf to preserve');
      console.log('   Anthropic\'s prompt cache during idle periods.\n');
    }
    const { startServer } = await import('../integrations/proxy/server.js');
    await startServer({ debug: options.debug ?? false });
  });

// grov proxy-status - Show active proxy sessions
program
  .command('proxy-status')
  .description('Show active proxy sessions')
  .action(safeAction(async () => {
    const { proxyStatus } = await import('./commands/proxy-status.js');
    await proxyStatus();
  }));

// grov login - Authenticate with Grov cloud
program
  .command('login')
  .description('Login to Grov cloud (opens browser for authentication)')
  .action(safeAction(async () => {
    const { login } = await import('./commands/login.js');
    await login();
  }));

// grov logout - Clear stored credentials
program
  .command('logout')
  .description('Logout from Grov cloud')
  .action(safeAction(async () => {
    const { logout } = await import('./commands/logout.js');
    await logout();
  }));

// grov uninstall - Full cleanup
program
  .command('uninstall')
  .description('Remove all grov data and configuration')
  .action(safeAction(async () => {
    const { uninstall } = await import('./commands/uninstall.js');
    await uninstall();
  }));

// grov sync - Configure cloud sync
program
  .command('sync')
  .description('Configure cloud sync to team dashboard')
  .option('--enable', 'Enable cloud sync')
  .option('--disable', 'Disable cloud sync')
  .option('--team <id>', 'Set team ID for sync')
  .option('--status', 'Show sync status')
  .option('--push', 'Upload any unsynced local tasks to the team')
  .action(safeAction(async (options: { enable?: boolean; disable?: boolean; team?: string; status?: boolean; push?: boolean }) => {
    const { sync } = await import('./commands/sync.js');
    await sync(options);
  }));

// grov doctor - Diagnose setup issues
program
  .command('doctor [agent]')
  .description('Check grov setup and diagnose issues (optional: claude, codex)')
  .action(safeAction(async (agent?: string) => {
    const { doctor } = await import('./commands/doctor.js');
    const agentName = agent === 'claude' || agent === 'codex' ? agent : undefined;
    await doctor(agentName);
  }));

// grov agents - List supported agents
program
  .command('agents')
  .description('List supported AI agents and setup instructions')
  .action(safeAction(async () => {
    const { agents } = await import('./commands/agents.js');
    agents();
  }));

// grov mcp - Start MCP server (called by Cursor, not user)
program
  .command('mcp')
  .description('Start MCP server for Cursor integration')
  .action(async () => {
    const { startMcpServer } = await import('../integrations/mcp/index.js');
    await startMcpServer();
  });

// grov setup - Configure integrations
const setup = program
  .command('setup')
  .description('Configure grov integrations');

setup
  .command('mcp cursor')
  .description('Configure MCP for Cursor IDE')
  .action(safeAction(async () => {
    const { setupMcpCursor } = await import('./commands/setup.js');
    await setupMcpCursor();
  }));

program.parse();
