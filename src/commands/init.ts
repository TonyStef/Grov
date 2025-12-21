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
    const isWindows = process.platform === 'win32';
    const shell = process.env.SHELL?.includes('zsh') ? '~/.zshrc' : '~/.bashrc';
    
    if (!process.env.ANTHROPIC_API_KEY) {
      console.log('\n╔═══════════════════════════════════════════════════════════╗');
      console.log('║  ⚠️  ANTHROPIC_API_KEY NOT SET - MEMORIES WILL NOT SYNC!  ║');
      console.log('╚═══════════════════════════════════════════════════════════╝');
      console.log('\n  1. Get your API key at:');
      console.log('     https://console.anthropic.com/settings/keys\n');
      
      if (isWindows) {
        console.log('  2. Set PERMANENTLY (run in Command Prompt as Admin):');
        console.log('     setx ANTHROPIC_API_KEY "sk-ant-..."\n');
        console.log('  3. Restart your terminal\n');
        console.log('  ⚠️  Using "set" alone only works in THAT terminal!');
      } else {
        console.log('  2. Add PERMANENTLY to your shell:');
        console.log(`     echo 'export ANTHROPIC_API_KEY=sk-ant-...' >> ${shell}\n`);
        console.log('  3. Apply changes:');
        console.log(`     source ${shell}\n`);
        console.log('  ⚠️  Using "export" alone only works in THAT terminal!');
      }
      console.log('     The key will be gone when you open a new terminal.\n');
    } else {
      console.log('\n  ✓ ANTHROPIC_API_KEY found');
    }

    console.log('\n--- Next Steps ---');
    console.log('1. Terminal 1: grov proxy');
    console.log('2. Terminal 2: claude');
    console.log('\nRun "grov doctor" to verify your setup is complete.');
    console.log('Grov will automatically capture reasoning and inject context.');

  } catch (error) {
    console.error('Failed to configure grov:', error instanceof Error ? error.message : 'Unknown error');
    process.exit(1);
  }
}
