// grov unregister - Remove hooks from Claude Code settings

import { unregisterGrovHooks, getSettingsPath, setProxyEnv } from '../lib/hooks.js';

export async function unregister(): Promise<void> {
  console.log('Removing grov hooks from Claude Code...\n');

  try {
    const { removed } = unregisterGrovHooks();

    if (removed.length > 0) {
      console.log('Removed hooks:');
      removed.forEach(hook => console.log(`  - ${hook}`));
    } else {
      console.log('No grov hooks found to remove.');
    }

    // Remove proxy URL from settings
    const proxyResult = setProxyEnv(false);
    if (proxyResult.action === 'removed') {
      console.log('\nProxy configuration:');
      console.log('  - ANTHROPIC_BASE_URL removed');
    }

    console.log(`\nSettings file: ${getSettingsPath()}`);
    console.log('\nGrov hooks have been disabled.');
    console.log('Your stored reasoning data remains in ~/.grov/memory.db');

  } catch (error) {
    console.error('Failed to unregister hooks:', error);
    process.exit(1);
  }
}
