#!/usr/bin/env node

import { Command } from 'commander';
import { closeDatabase } from './lib/store.js';

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
  .version('0.1.0');

// grov init - Register hooks in Claude Code
program
  .command('init')
  .description('Register grov hooks in Claude Code settings')
  .action(safeAction(async () => {
    const { init } = await import('./commands/init.js');
    await init();
  }));

// grov capture - Called by Stop hook, extracts and stores reasoning
program
  .command('capture')
  .description('Capture reasoning from current session (called by Stop hook)')
  .option('--session-dir <path>', 'Path to session directory')
  .action(safeAction(async (options: { sessionDir?: string }) => {
    // SECURITY: Validate session-dir doesn't contain path traversal
    if (options.sessionDir && options.sessionDir.includes('..')) {
      throw new Error('Invalid session directory path');
    }
    const { capture } = await import('./commands/capture.js');
    await capture(options);
  }));

// grov inject - Called by SessionStart hook, outputs context JSON
program
  .command('inject')
  .description('Inject relevant context for new session (called by SessionStart hook)')
  .option('--task <description>', 'Task description from user prompt')
  .action(safeAction(async (options: { task?: string }) => {
    const { inject } = await import('./commands/inject.js');
    await inject(options);
  }));

// grov prompt-inject - Called by UserPromptSubmit hook, outputs context JSON per-turn
program
  .command('prompt-inject')
  .description('Inject context before each prompt (called by UserPromptSubmit hook)')
  .action(safeAction(async () => {
    const { promptInject } = await import('./commands/prompt-inject.js');
    await promptInject({});
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

// grov unregister - Remove hooks from Claude Code
program
  .command('unregister')
  .description('Remove grov hooks from Claude Code settings')
  .action(safeAction(async () => {
    const { unregister } = await import('./commands/unregister.js');
    await unregister();
  }));

program.parse();
