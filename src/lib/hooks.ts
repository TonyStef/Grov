// Helper to read/write ~/.claude/settings.json

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const CLAUDE_DIR = join(homedir(), '.claude');
const SETTINGS_PATH = join(CLAUDE_DIR, 'settings.json');

interface ClaudeSettings {
  hooks?: {
    Stop?: string[];
    SessionStart?: string[];
    [key: string]: string[] | undefined;
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
  // Ensure .claude directory exists
  if (!existsSync(CLAUDE_DIR)) {
    mkdirSync(CLAUDE_DIR, { recursive: true });
  }

  writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

export function registerGrovHooks(): { added: string[]; alreadyExists: string[] } {
  const settings = readClaudeSettings();
  const added: string[] = [];
  const alreadyExists: string[] = [];

  // Initialize hooks object if it doesn't exist
  if (!settings.hooks) {
    settings.hooks = {};
  }

  // Register Stop hook for capture
  const stopCommand = 'grov capture';
  if (!settings.hooks.Stop) {
    settings.hooks.Stop = [];
  }
  if (!settings.hooks.Stop.includes(stopCommand)) {
    settings.hooks.Stop.push(stopCommand);
    added.push('Stop → grov capture');
  } else {
    alreadyExists.push('Stop → grov capture');
  }

  // Register SessionStart hook for inject
  const sessionStartCommand = 'grov inject';
  if (!settings.hooks.SessionStart) {
    settings.hooks.SessionStart = [];
  }
  if (!settings.hooks.SessionStart.includes(sessionStartCommand)) {
    settings.hooks.SessionStart.push(sessionStartCommand);
    added.push('SessionStart → grov inject');
  } else {
    alreadyExists.push('SessionStart → grov inject');
  }

  writeClaudeSettings(settings);

  return { added, alreadyExists };
}

export function unregisterGrovHooks(): { removed: string[] } {
  const settings = readClaudeSettings();
  const removed: string[] = [];

  if (settings.hooks?.Stop) {
    const idx = settings.hooks.Stop.indexOf('grov capture');
    if (idx !== -1) {
      settings.hooks.Stop.splice(idx, 1);
      removed.push('Stop → grov capture');
    }
  }

  if (settings.hooks?.SessionStart) {
    const idx = settings.hooks.SessionStart.indexOf('grov inject');
    if (idx !== -1) {
      settings.hooks.SessionStart.splice(idx, 1);
      removed.push('SessionStart → grov inject');
    }
  }

  writeClaudeSettings(settings);

  return { removed };
}

export function getSettingsPath(): string {
  return SETTINGS_PATH;
}
