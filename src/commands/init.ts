// grov init - Register hooks in Claude Code settings

import { registerGrovHooks, getSettingsPath } from '../lib/hooks.js';

export async function init(): Promise<void> {
  console.log('Registering grov hooks in Claude Code...\n');

  try {
    const { added, alreadyExists } = registerGrovHooks();

    if (added.length > 0) {
      console.log('Added hooks:');
      added.forEach(hook => console.log(`  + ${hook}`));
    }

    if (alreadyExists.length > 0) {
      console.log('Already registered:');
      alreadyExists.forEach(hook => console.log(`  = ${hook}`));
    }

    console.log(`\nSettings file: ${getSettingsPath()}`);
    console.log('\nGrov is now active! Your Claude Code sessions will automatically:');
    console.log('  - Capture reasoning after each task (Stop hook)');
    console.log('  - Inject relevant context at session start (SessionStart hook)');
    console.log('  - Inject targeted context before each prompt (UserPromptSubmit hook)');
    console.log('\nJust use Claude Code normally. Grov works in the background.');

  } catch (error) {
    console.error('Failed to register hooks:', error);
    process.exit(1);
  }
}
