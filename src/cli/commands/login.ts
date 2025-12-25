// Login command - Device authorization flow
// Authenticates CLI with Grov cloud using OAuth-like device flow

import open from 'open';
import * as readline from 'readline';
import { writeCredentials, isAuthenticated, readCredentials, setTeamId, setSyncEnabled } from '../../core/cloud/credentials.js';
import { startDeviceFlow, pollDeviceFlow, sleep, getApiUrl, fetchTeams } from '../../core/cloud/api-client.js';

/**
 * Prompt user for input
 */
function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

/**
 * Decode JWT payload to extract user info
 */
function decodeTokenPayload(token: string): { sub: string; email: string } | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const payload = JSON.parse(
      Buffer.from(parts[1], 'base64url').toString('utf-8')
    );

    return {
      sub: payload.sub,
      email: payload.email,
    };
  } catch {
    return null;
  }
}

export async function login(): Promise<void> {
  console.log('Logging in to Grov cloud...\n');

  // Check if already authenticated
  if (isAuthenticated()) {
    const creds = readCredentials();
    if (creds) {
      console.log(`Already logged in as ${creds.email}`);
      console.log('Run "grov logout" to log out first.\n');
      return;
    }
  }

  // Start device flow
  console.log('Starting device authorization...');

  const startResult = await startDeviceFlow();

  if (startResult.error || !startResult.data) {
    console.error(`\nError: ${startResult.error || 'Failed to start login flow'}`);
    console.error('Please check your network connection and try again.');
    process.exit(1);
  }

  const { device_code, user_code, verification_uri, expires_in, interval } = startResult.data;

  // Display code to user
  console.log('\n┌─────────────────────────────────────────┐');
  console.log('│                                         │');
  console.log(`│  Your code:  ${user_code}               │`);
  console.log('│                                         │');
  console.log('└─────────────────────────────────────────┘\n');

  console.log('Opening browser to authorize...');
  console.log(`If browser does not open, visit: ${verification_uri}?code=${user_code}\n`);

  // Open browser
  try {
    await open(`${verification_uri}?code=${user_code}`);
  } catch {
    console.log('Could not open browser automatically.');
    console.log(`Please visit: ${verification_uri}?code=${user_code}\n`);
  }

  // Poll for authorization
  console.log('Waiting for authorization...');

  const maxAttempts = Math.floor(expires_in / interval);
  let attempts = 0;

  while (attempts < maxAttempts) {
    await sleep(interval * 1000);
    attempts++;

    const pollResult = await pollDeviceFlow(device_code);

    if (pollResult.error) {
      process.stdout.write('.');
      continue;
    }

    if (!pollResult.data) {
      process.stdout.write('.');
      continue;
    }

    const { status, access_token, refresh_token, expires_at } = pollResult.data;

    if (status === 'authorized' && access_token && refresh_token && expires_at) {
      console.log('\n');

      // Decode token to get user info
      const userInfo = decodeTokenPayload(access_token);

      if (!userInfo) {
        console.error('Error: Failed to decode user info from token');
        process.exit(1);
      }

      // Save credentials
      writeCredentials({
        access_token,
        refresh_token,
        expires_at,
        user_id: userInfo.sub,
        email: userInfo.email,
        sync_enabled: false,
      });

      console.log('\n✓ Logged in as:', userInfo.email);

      // Auto-setup: Fetch teams and configure sync
      console.log('\nSetting up cloud sync...');

      try {
        const teams = await fetchTeams();

        if (teams.length === 0) {
          console.log('\n⚠ No teams found.');
          console.log('Create one at: https://app.grov.dev/team');
          console.log('Then run: grov sync --enable --team <team-id>\n');
          return;
        }

        let selectedTeam = teams[0];

        // If multiple teams, let user choose
        if (teams.length > 1) {
          console.log('\nYour teams:');
          teams.forEach((team, i) => {
            console.log(`  ${i + 1}. ${team.name} (${team.slug})`);
          });
          const choice = await prompt(`\nSelect team [1-${teams.length}] (default: 1): `);
          const index = parseInt(choice, 10) - 1;
          if (index >= 0 && index < teams.length) {
            selectedTeam = teams[index];
          }
        }

        // Ask to enable sync (default yes)
        const enableSync = await prompt(`Enable cloud sync to "${selectedTeam.name}"? [Y/n]: `);

        if (enableSync !== 'n' && enableSync !== 'no') {
          setTeamId(selectedTeam.id);
          setSyncEnabled(true);

          console.log('\n╔═════════════════════════════════════════╗');
          console.log('║                                         ║');
          console.log('║   ✓ Cloud sync enabled!                 ║');
          console.log('║                                         ║');
          console.log('╚═════════════════════════════════════════╝');
          console.log(`\nSyncing to: ${selectedTeam.name}`);
          
          // Check API key and warn if not set
          if (!process.env.ANTHROPIC_API_KEY) {
            const shell = process.env.SHELL?.includes('zsh') ? '~/.zshrc' : '~/.bashrc';
            console.log('\n⚠️  WARNING: ANTHROPIC_API_KEY not set - memories will NOT sync!');
            console.log('\n   Add PERMANENTLY to your shell (not just "export"):');
            console.log(`   echo 'export ANTHROPIC_API_KEY=sk-ant-...' >> ${shell}`);
            console.log(`   source ${shell}`);
            console.log('\n   Get your key at: https://console.anthropic.com/settings/keys');
          }
          
          console.log('\nRun "grov doctor" to verify your setup is complete.');
          console.log('View memories at: https://app.grov.dev/memories\n');
        } else {
          console.log('\n✓ Logged in. Sync not enabled.');
          console.log('Run "grov sync --enable" later to start syncing.\n');
        }

      } catch (err) {
        console.log('\n⚠ Could not auto-configure sync.');
        console.log('Run "grov sync --enable --team <team-id>" manually.');
        console.log('Find your team ID at: https://app.grov.dev/team\n');
      }

      return;
    }

    if (status === 'expired') {
      console.log('\n\nAuthorization expired. Please run "grov login" again.\n');
      process.exit(1);
    }

    // Still pending
    process.stdout.write('.');
  }

  console.log('\n\nAuthorization timed out. Please run "grov login" again.\n');
  process.exit(1);
}
