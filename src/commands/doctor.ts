// grov doctor - Check setup and diagnose issues

import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { request } from 'undici';
import { readCredentials, getSyncStatus } from '../lib/credentials.js';
import { initDatabase } from '../lib/store/database.js';

const CLAUDE_SETTINGS_PATH = join(homedir(), '.claude', 'settings.json');
const DB_PATH = join(homedir(), '.grov', 'memory.db');

export async function doctor(): Promise<void> {
  console.log('\nGrov Doctor');
  console.log('===========\n');

  // Check proxy
  const proxyRunning = await checkProxy();
  printCheck('Proxy', proxyRunning, 'Running on port 8080', 'Not running', 'grov proxy');

  // Check Claude settings
  const baseUrlConfigured = checkBaseUrl();
  printCheck('ANTHROPIC_BASE_URL', baseUrlConfigured, 'Configured for proxy', 'Not configured', 'grov init');

  // Check API key
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const hasApiKey = !!(apiKey && apiKey.length > 10);
  const shell = process.env.SHELL?.includes('zsh') ? '~/.zshrc' : '~/.bashrc';
  const apiKeyFix = process.platform === 'win32'
    ? 'setx ANTHROPIC_API_KEY "sk-ant-..." (permanent) or add to System Environment Variables'
    : `Add to ${shell}: echo 'export ANTHROPIC_API_KEY=sk-ant-...' >> ${shell} && source ${shell}`;
  printCheck('ANTHROPIC_API_KEY', hasApiKey, 'Set', 'NOT SET - memories will not sync!', apiKeyFix);

  // Check login
  const creds = readCredentials();
  printCheck('Login', !!creds, creds ? `Logged in as ${creds.email}` : 'Not logged in', 'Not logged in', 'grov login');

  // Check sync
  const syncStatus = getSyncStatus();
  const syncOk = syncStatus?.enabled && syncStatus?.teamId;
  const syncMsg = syncOk
    ? `Team ${syncStatus.teamId!.substring(0, 8)}...`
    : syncStatus?.teamId ? 'Disabled' : 'No team';
  printCheck('Cloud Sync', !!syncOk, syncMsg, syncMsg, 'grov sync --enable --team <id>');

  // Check database
  const dbStats = checkDatabase();
  const dbOk = dbStats.tasks > 0 || dbStats.sessions > 0;
  const dbMsg = `${dbStats.tasks} tasks, ${dbStats.unsynced} unsynced, ${dbStats.sessions} active`;
  printCheck('Local Database', dbOk, dbMsg, 'Empty', 'Use Claude Code with proxy running');

  console.log('');
}

async function checkProxy(): Promise<boolean> {
  try {
    const res = await request('http://127.0.0.1:8080/health', {
      headersTimeout: 2000,
      bodyTimeout: 2000
    });
    return res.statusCode === 200;
  } catch {
    return false;
  }
}

function checkBaseUrl(): boolean {
  if (!existsSync(CLAUDE_SETTINGS_PATH)) return false;
  try {
    const settings = JSON.parse(readFileSync(CLAUDE_SETTINGS_PATH, 'utf-8'));
    return settings.env?.ANTHROPIC_BASE_URL === 'http://127.0.0.1:8080';
  } catch {
    return false;
  }
}

function checkDatabase(): { tasks: number; unsynced: number; sessions: number } {
  if (!existsSync(DB_PATH)) {
    return { tasks: 0, unsynced: 0, sessions: 0 };
  }
  try {
    const db = initDatabase();
    const tasks = (db.prepare('SELECT COUNT(*) as c FROM tasks').get() as { c: number }).c;
    const unsynced = (db.prepare('SELECT COUNT(*) as c FROM tasks WHERE synced_at IS NULL').get() as { c: number }).c;
    const sessions = (db.prepare("SELECT COUNT(*) as c FROM session_states WHERE status = 'active'").get() as { c: number }).c;
    return { tasks, unsynced, sessions };
  } catch {
    return { tasks: 0, unsynced: 0, sessions: 0 };
  }
}

function printCheck(name: string, ok: boolean, successMsg: string, failMsg: string, fix: string): void {
  const icon = ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
  const msg = ok ? successMsg : failMsg;
  console.log(`${icon} ${name}: ${msg}`);
  if (!ok) {
    console.log(`  \x1b[90m→ ${fix}\x1b[0m`);
  }
}
