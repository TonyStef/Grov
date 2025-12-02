// grov init - Register hooks in Claude Code settings

import { registerGrovHooks, getSettingsPath, setProxyEnv } from '../lib/hooks.js';

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

    // Set up proxy URL in settings so users just type 'claude'
    const proxyResult = setProxyEnv(true);
    if (proxyResult.action === 'added') {
      console.log('\nProxy configuration:');
      console.log('  + ANTHROPIC_BASE_URL → http://127.0.0.1:8080');
    } else if (proxyResult.action === 'unchanged') {
      console.log('\nProxy configuration:');
      console.log('  = ANTHROPIC_BASE_URL already configured');
    }

    console.log(`\nSettings file: ${getSettingsPath()}`);
    console.log('\nGrov is now active! Your Claude Code sessions will automatically:');
    console.log('  - Capture reasoning after each task (Stop hook)');
    console.log('  - Inject relevant context at session start (SessionStart hook)');
    console.log('  - Inject targeted context before each prompt (UserPromptSubmit hook)');

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
      console.log('Without key: Basic context injection still works.');
      console.log('With key: Adds drift detection, smart extraction, team memory.');
    } else {
      console.log('\n  ANTHROPIC_API_KEY found');
    }

    console.log('\n--- OPTIONAL: Enable Full Features ---');
    console.log('To enable drift detection and real-time action tracking:');
    console.log('  1. Run: grov proxy    (in a separate terminal)');
    console.log('  2. Use Claude Code normally with: claude');

  } catch (error) {
    // SECURITY: Only show error message, not full stack trace with paths
    console.error('Failed to register hooks:', error instanceof Error ? error.message : 'Unknown error');
    process.exit(1);
  }
}
