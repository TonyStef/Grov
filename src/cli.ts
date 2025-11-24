#!/usr/bin/env node

import { Command } from 'commander';

const program = new Command();

program
  .name('grov')
  .description('Collective AI memory for engineering teams')
  .version('0.1.0');

// grov init - Register hooks in Claude Code
program
  .command('init')
  .description('Register grov hooks in Claude Code settings')
  .action(async () => {
    const { init } = await import('./commands/init.js');
    await init();
  });

// grov capture - Called by Stop hook, extracts and stores reasoning
program
  .command('capture')
  .description('Capture reasoning from current session (called by Stop hook)')
  .option('--session-dir <path>', 'Path to session directory')
  .action(async (options) => {
    const { capture } = await import('./commands/capture.js');
    await capture(options);
  });

// grov inject - Called by SessionStart hook, outputs context JSON
program
  .command('inject')
  .description('Inject relevant context for new session (called by SessionStart hook)')
  .option('--task <description>', 'Task description from user prompt')
  .action(async (options) => {
    const { inject } = await import('./commands/inject.js');
    await inject(options);
  });

// grov status - Show stored reasoning for current project
program
  .command('status')
  .description('Show stored reasoning for current project')
  .option('--all', 'Show all tasks, not just completed')
  .action(async (options) => {
    const { status } = await import('./commands/status.js');
    await status(options);
  });

// grov unregister - Remove hooks from Claude Code
program
  .command('unregister')
  .description('Remove grov hooks from Claude Code settings')
  .action(async () => {
    const { unregister } = await import('./commands/unregister.js');
    await unregister();
  });

program.parse();
