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

// grov init - Configure AI agent to use grov proxy/MCP
program
  .command('init [agent]')
  .description('Configure AI agent (claude, codex, or cursor)')
  .action(safeAction(async (agent?: string) => {
    const { init } = await import('./commands/init.js');
    if (agent === 'cursor') {
      await init('cursor');
    } else {
      const agentName = (agent === 'codex' ? 'codex' : 'claude') as 'claude' | 'codex';
      await init(agentName);
    }
  }));

// grov disable - Remove proxy/MCP configuration
program
  .command('disable [agent]')
  .description('Disable grov for AI agent (claude, codex, or cursor)')
  .action(safeAction(async (agent?: string) => {
    const { disable } = await import('./commands/disable.js');
    if (agent === 'cursor') {
      await disable('cursor');
    } else {
      const agentName = (agent === 'codex' ? 'codex' : 'claude') as 'claude' | 'codex';
      await disable(agentName);
    }
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

// grov drift-test - Test drift detection on a prompt (internal/debug)
program
  .command('drift-test', { hidden: true })
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

// grov setup - Interactive setup wizard
program
  .command('setup')
  .description('Interactive setup wizard for new users')
  .action(safeAction(async () => {
    const { setup } = await import('./commands/setup.js');
    await setup();
  }));

// grov mcp - Start MCP server (called by Cursor, not user)
program
  .command('mcp', { hidden: true })
  .description('Start MCP server for Cursor integration')
  .action(async () => {
    const { startMcpServer } = await import('../integrations/mcp/index.js');
    await startMcpServer();
  });

// Smart no-args behavior: show "get started" or status
async function showSmartDefault(): Promise<void> {
  const { isAuthenticated, getSyncStatus } = await import('../core/cloud/credentials.js');
  const { isAnyAgentConfigured, getFirstConfiguredAgent } = await import('./agents/registry.js');

  const loggedIn = isAuthenticated();
  const agentConfigured = isAnyAgentConfigured();

  if (!loggedIn && !agentConfigured) {
    // First run - show get started
    console.log('\ngrov - Collective AI memory for engineering teams\n');
    console.log('┌─────────────────────────────────────────────────────────────┐');
    console.log('│  GET STARTED                                                │');
    console.log('│                                                             │');
    console.log('│  Run: grov setup                                            │');
    console.log('│                                                             │');
    console.log('│  This will:                                                 │');
    console.log('│  • Connect to your team dashboard                           │');
    console.log('│  • Configure your AI agent (Claude, Codex, Cursor, etc.)    │');
    console.log('│  • Show you exactly how to use grov                         │');
    console.log('└─────────────────────────────────────────────────────────────┘');
    console.log('\nOr see all commands: grov --help\n');
    return;
  }

  // Setup done - show status dashboard
  console.log('\ngrov - Collective AI memory for engineering teams\n');
  console.log('STATUS');

  const agent = getFirstConfiguredAgent();
  if (agent) {
    console.log(`\x1b[32m●\x1b[0m ${agent.name}    Configured`);
  } else {
    console.log('\x1b[90m○\x1b[0m Agent       Not configured');
  }

  const syncStatus = getSyncStatus();
  if (syncStatus?.enabled && syncStatus.teamId) {
    console.log(`\x1b[32m●\x1b[0m Team Sync   Enabled`);
  } else if (loggedIn) {
    console.log('\x1b[33m○\x1b[0m Team Sync   Disabled');
  } else {
    console.log('\x1b[90m○\x1b[0m Team Sync   Not logged in');
  }

  if (agent?.type === 'cli') {
    console.log('\nTO USE:');
    console.log('  Terminal 1: grov proxy');
    console.log(`  Terminal 2: ${agent.command}`);
  } else if (agent?.type === 'ide') {
    console.log('\nTO USE:');
    console.log(`  Restart ${agent.name} and use normally`);
  }

  console.log('\nCOMMANDS');
  console.log('  grov proxy     Start the proxy (for CLI agents)');
  console.log('  grov status    View captured memories');
  console.log('  grov doctor    Check setup health');
  console.log('\nAll commands: grov --help\n');
}

// Check if no args - show smart default
if (process.argv.length === 2) {
  showSmartDefault().catch(err => {
    console.error('Error:', err instanceof Error ? err.message : 'Unknown error');
    process.exit(1);
  });
} else {
  program.parse();
}
