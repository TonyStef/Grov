// grov doctor - Check setup and diagnose issues

import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { request } from 'undici';
import { parse } from 'smol-toml';
import { readCredentials, getSyncStatus } from '../../core/cloud/credentials.js';
import { initDatabase } from '../../core/store/database.js';

const CLAUDE_SETTINGS_PATH = join(homedir(), '.claude', 'settings.json');
const CODEX_CONFIG_PATH = join(homedir(), '.codex', 'config.toml');
const CURSOR_MCP_PATH = join(homedir(), '.cursor', 'mcp.json');
const DB_PATH = join(homedir(), '.grov', 'memory.db');

type AgentName = 'claude' | 'codex' | 'cursor';

export async function doctor(agent?: AgentName): Promise<void> {
  console.log('\nGrov Doctor');
  console.log('===========\n');

  if (!agent) {
    await runGeneralChecks();
    console.log('\n--- Agent Status ---\n');
    checkAgentStatus('claude');
    checkAgentStatus('codex');
    checkAgentStatus('cursor');
    console.log('\n\x1b[90mRun grov doctor <agent> for detailed checks\x1b[0m');
  } else if (agent === 'claude') {
    await runClaudeChecks();
  } else if (agent === 'codex') {
    await runCodexChecks();
  } else if (agent === 'cursor') {
    await runCursorChecks();
  }

  console.log('');
}

async function runGeneralChecks(): Promise<void> {
  const proxyRunning = await checkProxy();
  printCheck('Proxy', proxyRunning, 'Running on port 8080', 'Not running', 'grov proxy');

  const creds = readCredentials();
  printCheck('Login', !!creds, creds ? `Logged in as ${creds.email}` : 'Not logged in', 'Not logged in', 'grov login');

  const syncStatus = getSyncStatus();
  const syncOk = syncStatus?.enabled && syncStatus?.teamId;
  const syncMsg = syncOk
    ? `Team ${syncStatus.teamId!.substring(0, 8)}...`
    : syncStatus?.teamId ? 'Disabled' : 'No team';
  printCheck('Cloud Sync', !!syncOk, syncMsg, syncMsg, 'grov sync --enable --team <id>');

  const dbStats = checkDatabase();
  const dbOk = dbStats.tasks > 0 || dbStats.sessions > 0;
  const dbMsg = `${dbStats.tasks} tasks, ${dbStats.unsynced} unsynced, ${dbStats.sessions} active`;
  printCheck('Local Database', dbOk, dbMsg, 'Empty', 'Use an AI agent with proxy running');
}

function checkAgentStatus(agent: AgentName): void {
  if (agent === 'claude') {
    const configured = isClaudeConfigured();
    const icon = configured ? '\x1b[32m●\x1b[0m' : '\x1b[90m○\x1b[0m';
    const status = configured ? 'Configured' : 'Not configured';
    console.log(`${icon} Claude Code: ${status}`);
    if (!configured) {
      console.log('  \x1b[90m→ grov init claude\x1b[0m');
    }
  } else if (agent === 'codex') {
    const configured = isCodexConfigured();
    const icon = configured ? '\x1b[32m●\x1b[0m' : '\x1b[90m○\x1b[0m';
    const status = configured ? 'Configured' : 'Not configured';
    console.log(`${icon} Codex CLI: ${status}`);
    if (!configured) {
      console.log('  \x1b[90m→ grov init codex\x1b[0m');
    }
  } else if (agent === 'cursor') {
    const configured = isCursorConfigured();
    const icon = configured ? '\x1b[32m●\x1b[0m' : '\x1b[90m○\x1b[0m';
    const status = configured ? 'Configured' : 'Not configured';
    console.log(`${icon} Cursor: ${status}`);
    if (!configured) {
      console.log('  \x1b[90m→ grov init cursor\x1b[0m');
    }
  }
}

async function runClaudeChecks(): Promise<void> {
  console.log('Claude Code Checks\n');

  const proxyRunning = await checkProxy();
  printCheck('Proxy', proxyRunning, 'Running on port 8080', 'Not running', 'grov proxy');

  const baseUrlConfigured = isClaudeConfigured();
  printCheck('ANTHROPIC_BASE_URL', baseUrlConfigured, 'Configured for proxy', 'Not configured', 'grov init claude');

  // Note: ANTHROPIC_API_KEY not needed - Claude Code auth comes from request headers

  const settingsPath = CLAUDE_SETTINGS_PATH;
  const hasSettings = existsSync(settingsPath);
  printCheck('Settings file', hasSettings, settingsPath, 'Not found', 'Run claude once to create settings');
}

async function runCodexChecks(): Promise<void> {
  console.log('Codex CLI Checks\n');

  const proxyRunning = await checkProxy();
  printCheck('Proxy', proxyRunning, 'Running on port 8080', 'Not running', 'grov proxy');

  const configured = isCodexConfigured();
  printCheck('model_provider', configured, 'Set to grov', 'Not configured', 'grov init codex');

  const apiKey = process.env.OPENAI_API_KEY;
  const hasApiKey = !!(apiKey && apiKey.length > 10);
  const shell = process.env.SHELL?.includes('zsh') ? '~/.zshrc' : '~/.bashrc';
  const apiKeyFix = process.platform === 'win32'
    ? 'setx OPENAI_API_KEY "sk-..." (permanent)'
    : `Add to ${shell}: export OPENAI_API_KEY=sk-...`;
  printCheck('OPENAI_API_KEY', hasApiKey, 'Set', 'NOT SET - Codex will not work', apiKeyFix);

  const configPath = CODEX_CONFIG_PATH;
  const hasConfig = existsSync(configPath);
  printCheck('Config file', hasConfig, configPath, 'Not found', 'Run codex once to create config');
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

function isClaudeConfigured(): boolean {
  if (!existsSync(CLAUDE_SETTINGS_PATH)) return false;
  try {
    const settings = JSON.parse(readFileSync(CLAUDE_SETTINGS_PATH, 'utf-8'));
    return settings.env?.ANTHROPIC_BASE_URL === 'http://127.0.0.1:8080';
  } catch {
    return false;
  }
}

function isCodexConfigured(): boolean {
  if (!existsSync(CODEX_CONFIG_PATH)) return false;
  try {
    const content = readFileSync(CODEX_CONFIG_PATH, 'utf-8');
    const config = parse(content) as { model_provider?: string; model_providers?: { grov?: unknown } };
    return config.model_provider === 'grov' && !!config.model_providers?.grov;
  } catch {
    return false;
  }
}

function isCursorConfigured(): boolean {
  if (!existsSync(CURSOR_MCP_PATH)) return false;
  try {
    const content = readFileSync(CURSOR_MCP_PATH, 'utf-8');
    const config = JSON.parse(content) as { mcpServers?: { grov?: unknown } };
    return !!config.mcpServers?.grov;
  } catch {
    return false;
  }
}

async function runCursorChecks(): Promise<void> {
  console.log('Cursor Checks\n');

  const mcpConfigured = isCursorConfigured();
  printCheck('MCP Server', mcpConfigured, 'Registered in ~/.cursor/mcp.json', 'Not registered', 'grov init cursor');

  const projectDir = process.cwd();
  const hasGrovRules = existsSync(join(projectDir, '.grov', 'rules.mdc'));
  printCheck('Project Rules', hasGrovRules, '.grov/rules.mdc exists', 'Not found', 'grov init cursor');

  const hasPointer = existsSync(join(projectDir, '.cursor', 'rules', '90_grov.mdc'));
  printCheck('Cursor Pointer', hasPointer, '.cursor/rules/90_grov.mdc exists', 'Not found', 'grov init cursor');

  const cursorDir = join(homedir(), '.cursor');
  printCheck('Cursor Installed', existsSync(cursorDir), '~/.cursor exists', 'Not found', 'Install Cursor IDE');
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
