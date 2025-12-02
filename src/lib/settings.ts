// Claude Code settings management
// Handles ~/.claude/settings.json read/write and proxy configuration

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const CLAUDE_DIR = join(homedir(), '.claude');
const SETTINGS_PATH = join(CLAUDE_DIR, 'settings.json');

interface ClaudeSettings {
  hooks?: Record<string, unknown>;
  env?: {
    ANTHROPIC_BASE_URL?: string;
    [key: string]: string | undefined;
  };
  [key: string]: unknown;
}

export function readClaudeSettings(): ClaudeSettings {
  if (!existsSync(SETTINGS_PATH)) {
    return {};
  }

  try {
    const content = readFileSync(SETTINGS_PATH, 'utf-8');
    return JSON.parse(content) as ClaudeSettings;
  } catch {
    console.error('Warning: Could not parse ~/.claude/settings.json');
    return {};
  }
}

export function writeClaudeSettings(settings: ClaudeSettings): void {
  // Ensure .claude directory exists with restricted permissions
  if (!existsSync(CLAUDE_DIR)) {
    mkdirSync(CLAUDE_DIR, { recursive: true, mode: 0o700 });
  }

  writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), { mode: 0o600 });
}

export function getSettingsPath(): string {
  return SETTINGS_PATH;
}

/**
 * Set or remove ANTHROPIC_BASE_URL in settings.json env section.
 * This allows users to just type 'claude' instead of setting env var manually.
 */
export function setProxyEnv(enable: boolean): { action: 'added' | 'removed' | 'unchanged' } {
  const settings = readClaudeSettings();
  const PROXY_URL = 'http://127.0.0.1:8080';

  if (enable) {
    // Add env.ANTHROPIC_BASE_URL
    if (!settings.env) {
      settings.env = {};
    }
    if (settings.env.ANTHROPIC_BASE_URL === PROXY_URL) {
      return { action: 'unchanged' };
    }
    settings.env.ANTHROPIC_BASE_URL = PROXY_URL;
    writeClaudeSettings(settings);
    return { action: 'added' };
  } else {
    // Remove env.ANTHROPIC_BASE_URL
    if (!settings.env?.ANTHROPIC_BASE_URL) {
      return { action: 'unchanged' };
    }
    delete settings.env.ANTHROPIC_BASE_URL;
    // Clean up empty env object
    if (Object.keys(settings.env).length === 0) {
      delete settings.env;
    }
    writeClaudeSettings(settings);
    return { action: 'removed' };
  }
}
