// Secure credential storage for CLI authentication
// Stores tokens at ~/.grov/credentials.json with 0o600 permissions

import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, chmodSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { request } from 'undici';

const GROV_DIR = join(homedir(), '.grov');
const CREDENTIALS_PATH = join(GROV_DIR, 'credentials.json');

// Credentials stored on disk
export interface Credentials {
  access_token: string;
  refresh_token: string;
  expires_at: string;   // ISO 8601 timestamp
  user_id: string;
  email: string;
  team_id?: string;     // Selected team for sync
  sync_enabled: boolean;
}

/**
 * Ensure .grov directory exists with proper permissions
 */
function ensureGrovDir(): void {
  if (!existsSync(GROV_DIR)) {
    mkdirSync(GROV_DIR, { recursive: true, mode: 0o700 });
  }
}

/**
 * Read credentials from disk
 * @returns Credentials or null if not found/invalid
 */
export function readCredentials(): Credentials | null {
  if (!existsSync(CREDENTIALS_PATH)) {
    return null;
  }

  try {
    const content = readFileSync(CREDENTIALS_PATH, 'utf-8');
    const creds = JSON.parse(content) as Credentials;

    // Validate required fields
    if (!creds.access_token || !creds.refresh_token || !creds.expires_at) {
      return null;
    }

    return creds;
  } catch {
    return null;
  }
}

/**
 * Write credentials to disk with secure permissions
 */
export function writeCredentials(creds: Credentials): void {
  ensureGrovDir();

  // Write with restrictive permissions (owner read/write only)
  writeFileSync(CREDENTIALS_PATH, JSON.stringify(creds, null, 2), { mode: 0o600 });

  // Ensure permissions are correct even if file existed
  chmodSync(CREDENTIALS_PATH, 0o600);
}

/**
 * Clear credentials (logout)
 */
export function clearCredentials(): void {
  if (existsSync(CREDENTIALS_PATH)) {
    unlinkSync(CREDENTIALS_PATH);
  }
}

/**
 * Check if user is authenticated (has valid credentials)
 */
export function isAuthenticated(): boolean {
  const creds = readCredentials();
  return creds !== null;
}

/**
 * Check if access token is expired or will expire soon (within 5 minutes)
 */
function isTokenExpiringSoon(expiresAt: string): boolean {
  const expiryTime = new Date(expiresAt).getTime();
  const bufferTime = 5 * 60 * 1000; // 5 minutes
  return Date.now() > expiryTime - bufferTime;
}

/**
 * Refresh tokens using the API
 * @returns New credentials or null if refresh failed
 */
async function refreshTokens(refreshToken: string, apiUrl: string): Promise<Credentials | null> {
  try {
    const response = await request(`${apiUrl}/auth/refresh`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });

    if (response.statusCode !== 200) {
      return null;
    }

    const data = await response.body.json() as {
      access_token: string;
      refresh_token: string;
      expires_at: string;
    };

    // Decode user info from new token (basic decode, no verification needed here)
    const payload = decodeTokenPayload(data.access_token);
    if (!payload) {
      return null;
    }

    // Read existing credentials to preserve team_id and sync_enabled
    const existing = readCredentials();

    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: data.expires_at,
      user_id: payload.sub,
      email: payload.email,
      team_id: existing?.team_id,
      sync_enabled: existing?.sync_enabled ?? false,
    };
  } catch {
    return null;
  }
}

/**
 * Decode JWT payload without verification (for extracting user info)
 * WARNING: Do not use for authentication - tokens are verified server-side
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

/**
 * Get a valid access token, refreshing if necessary
 * @returns Access token or null if not authenticated
 */
export async function getAccessToken(): Promise<string | null> {
  const creds = readCredentials();

  if (!creds) {
    return null;
  }

  // Check if token needs refresh
  if (isTokenExpiringSoon(creds.expires_at)) {
    const apiUrl = process.env.GROV_API_URL || 'https://api.grov.dev';
    const newCreds = await refreshTokens(creds.refresh_token, apiUrl);

    if (newCreds) {
      writeCredentials(newCreds);
      return newCreds.access_token;
    }

    // Refresh failed - user needs to login again
    return null;
  }

  return creds.access_token;
}

/**
 * Set the team ID for sync
 */
export function setTeamId(teamId: string): void {
  const creds = readCredentials();

  if (!creds) {
    throw new Error('Not authenticated. Please run: grov login');
  }

  writeCredentials({
    ...creds,
    team_id: teamId,
  });
}

/**
 * Enable or disable sync
 */
export function setSyncEnabled(enabled: boolean): void {
  const creds = readCredentials();

  if (!creds) {
    throw new Error('Not authenticated. Please run: grov login');
  }

  writeCredentials({
    ...creds,
    sync_enabled: enabled,
  });
}

/**
 * Get current sync status
 */
export function getSyncStatus(): { enabled: boolean; teamId: string | undefined } | null {
  const creds = readCredentials();

  if (!creds) {
    return null;
  }

  return {
    enabled: creds.sync_enabled,
    teamId: creds.team_id,
  };
}

/**
 * Get current user info
 */
export function getCurrentUser(): { id: string; email: string } | null {
  const creds = readCredentials();

  if (!creds) {
    return null;
  }

  return {
    id: creds.user_id,
    email: creds.email,
  };
}
