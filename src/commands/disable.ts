// grov disable - Remove proxy configuration and restore direct Anthropic connection

import { setProxyEnv, getSettingsPath } from '../lib/settings.js';

export async function disable(): Promise<void> {
  const result = setProxyEnv(false);

  if (result.action === 'removed') {
    console.log('Grov disabled.');
    console.log('  - ANTHROPIC_BASE_URL removed from settings');
  } else {
    console.log('Grov was not configured.');
  }

  console.log(`\nSettings file: ${getSettingsPath()}`);
  console.log('\nClaude will now connect directly to Anthropic.');
}
