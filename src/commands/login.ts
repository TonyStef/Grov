// Login command - Device authorization flow
// Authenticates CLI with Grov cloud using OAuth-like device flow

import open from 'open';
import { writeCredentials, isAuthenticated, readCredentials } from '../lib/credentials.js';
import { startDeviceFlow, pollDeviceFlow, sleep, getApiUrl } from '../lib/api-client.js';

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

      console.log('╔═════════════════════════════════════════╗');
      console.log('║                                         ║');
      console.log('║   Successfully logged in!               ║');
      console.log('║                                         ║');
      console.log('╚═════════════════════════════════════════╝');
      console.log(`\nLogged in as: ${userInfo.email}\n`);

      console.log('Next steps:');
      console.log('  1. Run "grov sync --status" to check sync settings');
      console.log('  2. Run "grov sync --enable --team <team-id>" to enable sync');
      console.log('  3. Run "grov status" to view local memories\n');

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
