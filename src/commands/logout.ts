// Logout command - Clear stored credentials

import { clearCredentials, readCredentials } from '../lib/credentials.js';

export async function logout(): Promise<void> {
  const creds = readCredentials();

  if (!creds) {
    console.log('Not currently logged in.\n');
    return;
  }

  console.log(`Logging out ${creds.email}...`);

  clearCredentials();

  console.log('Successfully logged out.\n');
  console.log('Run "grov login" to log in again.\n');
}
