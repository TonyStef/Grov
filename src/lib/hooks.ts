// Helper to read/write ~/.claude/settings.json

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { homedir } from 'os';
import { join } from 'path';

const CLAUDE_DIR = join(homedir(), '.claude');
const SETTINGS_PATH = join(CLAUDE_DIR, 'settings.json');

/**
 * Find the absolute path to the grov executable
 * This is needed because Claude Code hooks may not have the same PATH
 */
function findGrovPath(): string {
  try {
    // Try to find grov using 'which'
    const result = execSync('which grov', { encoding: 'utf-8' }).trim();
    if (result && existsSync(result)) {
      return result;
    }
  } catch {
    // which failed, try common locations
  }

  // Common locations for npm global binaries
  const commonPaths = [
    '/opt/homebrew/bin/grov',           // macOS ARM (M1/M2)
    '/usr/local/bin/grov',              // macOS Intel / Linux
    join(homedir(), '.npm-global/bin/grov'),  // Custom npm prefix
    join(homedir(), '.nvm/versions/node', process.version, 'bin/grov'), // nvm
  ];

  for (const p of commonPaths) {
    if (existsSync(p)) {
      return p;
    }
  }

  // Fallback to just 'grov' and hope it's in PATH
  return 'grov';
}

// New hook format (Claude Code 2.x+)
interface HookCommand {
  type: 'command';
  command: string;
}

interface HookEntry {
  matcher?: Record<string, unknown>;
  hooks: HookCommand[];
}

interface ClaudeSettings {
  hooks?: {
    Stop?: HookEntry[];
    SessionStart?: HookEntry[];
    [key: string]: HookEntry[] | undefined;
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

  // Get absolute path to grov executable
  const grovPath = findGrovPath();

  // Initialize hooks object if it doesn't exist
  if (!settings.hooks) {
    settings.hooks = {};
  }

  // Helper to check if a grov command already exists (check for both relative and absolute paths)
  const hasGrovCommand = (entries: HookEntry[] | undefined, commandSuffix: string): boolean => {
    if (!entries) return false;
    return entries.some(entry =>
      entry.hooks.some(h => h.type === 'command' && h.command.endsWith(commandSuffix))
    );
  };

  // Register Stop hook for capture
  // Note: Stop/SessionStart hooks don't use matcher (only tool-specific hooks do)
  const stopCommand = `${grovPath} capture`;
  if (!settings.hooks.Stop) {
    settings.hooks.Stop = [];
  }
  if (!hasGrovCommand(settings.hooks.Stop, 'grov capture') && !hasGrovCommand(settings.hooks.Stop, stopCommand)) {
    settings.hooks.Stop.push({
      hooks: [{ type: 'command', command: stopCommand }]
    });
    added.push(`Stop → ${stopCommand}`);
  } else {
    alreadyExists.push('Stop → grov capture');
  }

  // Register SessionStart hook for inject
  const sessionStartCommand = `${grovPath} inject`;
  if (!settings.hooks.SessionStart) {
    settings.hooks.SessionStart = [];
  }
  if (!hasGrovCommand(settings.hooks.SessionStart, 'grov inject') && !hasGrovCommand(settings.hooks.SessionStart, sessionStartCommand)) {
    settings.hooks.SessionStart.push({
      hooks: [{ type: 'command', command: sessionStartCommand }]
    });
    added.push(`SessionStart → ${sessionStartCommand}`);
  } else {
    alreadyExists.push('SessionStart → grov inject');
  }

  writeClaudeSettings(settings);

  return { added, alreadyExists };
}

export function unregisterGrovHooks(): { removed: string[] } {
  const settings = readClaudeSettings();
  const removed: string[] = [];

  // Helper to find and remove grov command entries (handles both relative and absolute paths)
  const removeGrovCommands = (entries: HookEntry[] | undefined, commandSuffix: string): HookEntry[] | undefined => {
    if (!entries) return undefined;

    // Filter out entries that contain any grov command ending with the suffix
    const filtered = entries.filter(entry => {
      const hasCommand = entry.hooks.some(h =>
        h.type === 'command' && h.command.endsWith(commandSuffix)
      );
      return !hasCommand;
    });

    return filtered.length > 0 ? filtered : undefined;
  };

  // Also handle old string format for cleanup
  const removeOldFormat = (entries: unknown[], commandSuffix: string): unknown[] => {
    return entries.filter(entry => {
      if (typeof entry === 'string') {
        return !entry.endsWith(commandSuffix);
      }
      return true;
    });
  };

  if (settings.hooks?.Stop) {
    const originalLength = settings.hooks.Stop.length;

    // Remove new format (handles both 'grov capture' and '/path/to/grov capture')
    const newFormatFiltered = removeGrovCommands(settings.hooks.Stop, 'grov capture');

    // Also clean up old string format if present
    const cleaned = removeOldFormat(newFormatFiltered || [], 'grov capture') as HookEntry[];

    if (cleaned.length < originalLength) {
      removed.push('Stop → grov capture');
    }

    settings.hooks.Stop = cleaned.length > 0 ? cleaned : undefined;
  }

  if (settings.hooks?.SessionStart) {
    const originalLength = settings.hooks.SessionStart.length;

    // Remove new format (handles both 'grov inject' and '/path/to/grov inject')
    const newFormatFiltered = removeGrovCommands(settings.hooks.SessionStart, 'grov inject');

    // Also clean up old string format if present
    const cleaned = removeOldFormat(newFormatFiltered || [], 'grov inject') as HookEntry[];

    if (cleaned.length < originalLength) {
      removed.push('SessionStart → grov inject');
    }

    settings.hooks.SessionStart = cleaned.length > 0 ? cleaned : undefined;
  }

  // Clean up empty hooks object
  if (settings.hooks && Object.keys(settings.hooks).every(k => !settings.hooks![k])) {
    delete settings.hooks;
  }

  writeClaudeSettings(settings);

  return { removed };
}

export function getSettingsPath(): string {
  return SETTINGS_PATH;
}
