// grov init - Configure Claude Code to use grov proxy

import { setProxyEnv, getSettingsPath } from '../lib/settings.js';

export async function init(): Promise<void> {
  console.log('Configuring grov...\n');

  try {
    // Set up proxy URL in settings so users just type 'claude'
    const result = setProxyEnv(true);

    if (result.action === 'added') {
      console.log('  + ANTHROPIC_BASE_URL → http://127.0.0.1:8080');
    } else if (result.action === 'unchanged') {
      console.log('  = ANTHROPIC_BASE_URL already configured');
    }

    console.log(`\nSettings file: ${getSettingsPath()}`);

    // Check for API key and provide helpful instructions
    if (!process.env.ANTHROPIC_API_KEY) {
      console.log('\n' + '='.repeat(50));
      console.log('  ANTHROPIC_API_KEY not found');
      console.log('='.repeat(50));
      console.log('\nTo enable drift detection and smart extraction:\n');
      console.log('  1. Get your API key at:');
      console.log('     https://console.anthropic.com/settings/keys\n');
      console.log('  2. Add to your shell profile (~/.zshrc or ~/.bashrc):');
      console.log('     export ANTHROPIC_API_KEY=sk-ant-...\n');
      console.log('  3. Restart terminal or run: source ~/.zshrc\n');
    } else {
      console.log('\n  ANTHROPIC_API_KEY found');
    }

    console.log('\n--- Next Steps ---');
    console.log('1. Terminal 1: grov proxy');
    console.log('2. Terminal 2: claude');
    console.log('\nGrov will automatically capture reasoning and inject context.');

  } catch (error) {
    console.error('Failed to configure grov:', error instanceof Error ? error.message : 'Unknown error');
    process.exit(1);
  }
}
