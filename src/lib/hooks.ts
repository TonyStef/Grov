// Helper to read/write ~/.claude/settings.json

import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const CLAUDE_DIR = join(homedir(), '.claude');
const SETTINGS_PATH = join(CLAUDE_DIR, 'settings.json');

// Cache for grov path to avoid repeated file system checks
let cachedGrovPath: string | null = null;

/**
 * Safe locations where grov executable can be found.
 * We only check these known paths - no shell commands are executed.
 */
const SAFE_GROV_LOCATIONS = [
  '/opt/homebrew/bin/grov',                    // macOS ARM (Homebrew)
  '/usr/local/bin/grov',                       // macOS Intel / Linux
  '/usr/bin/grov',                             // System-wide Linux
  join(homedir(), '.npm-global/bin/grov'),     // Custom npm prefix
  join(homedir(), '.local/bin/grov'),          // Local user bin
];

/**
 * Get nvm-based paths for current and common Node versions.
 * Returns paths without executing any shell commands.
 */
function getNvmPaths(): string[] {
  const nvmDir = join(homedir(), '.nvm/versions/node');
  const paths: string[] = [];

  // Add current Node version path
  paths.push(join(nvmDir, process.version, 'bin/grov'));

  // Try common LTS versions
  const ltsVersions = ['v18', 'v20', 'v22'];
  for (const ver of ltsVersions) {
    try {
      const versionDir = join(nvmDir, ver);
      if (existsSync(versionDir)) {
        // Find actual version directories
        const entries = readdirSync(versionDir);
        for (const entry of entries) {
          paths.push(join(nvmDir, ver, entry, 'bin/grov'));
        }
      }
    } catch {
      // Skip if can't read directory
    }
  }

  return paths;
}

/**
 * Find the absolute path to the grov executable.
 * SECURITY: Only checks known safe locations - no shell command execution.
 * OPTIMIZED: Caches result to avoid repeated file system checks.
 */
function findGrovPath(): string {
  // Return cached path if available
  if (cachedGrovPath) {
    return cachedGrovPath;
  }

  // Check safe locations first
  for (const p of SAFE_GROV_LOCATIONS) {
    if (existsSync(p)) {
      cachedGrovPath = p;
      return p;
    }
  }

  // Check nvm locations
  for (const p of getNvmPaths()) {
    if (existsSync(p)) {
      cachedGrovPath = p;
      return p;
    }
  }

  // Check if running from source (development mode)
  try {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const localCli = resolve(__dirname, '../../dist/cli.js');
    if (existsSync(localCli)) {
      cachedGrovPath = `node "${localCli}"`;
      return cachedGrovPath;
    }
  } catch {
    // ESM import.meta not available, skip
  }

  // Fallback to just 'grov' - will work if it's in PATH
  cachedGrovPath = 'grov';
  return cachedGrovPath;
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
  // Ensure .claude directory exists with restricted permissions
  if (!existsSync(CLAUDE_DIR)) {
    mkdirSync(CLAUDE_DIR, { recursive: true, mode: 0o700 });
  }

  writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), { mode: 0o600 });
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

  // Register UserPromptSubmit hook for continuous context injection
  const promptInjectCommand = `${grovPath} prompt-inject`;
  if (!settings.hooks.UserPromptSubmit) {
    settings.hooks.UserPromptSubmit = [];
  }
  if (!hasGrovCommand(settings.hooks.UserPromptSubmit, 'grov prompt-inject') && !hasGrovCommand(settings.hooks.UserPromptSubmit, promptInjectCommand)) {
    settings.hooks.UserPromptSubmit.push({
      hooks: [{ type: 'command', command: promptInjectCommand }]
    });
    added.push(`UserPromptSubmit → ${promptInjectCommand}`);
  } else {
    alreadyExists.push('UserPromptSubmit → grov prompt-inject');
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

  if (settings.hooks?.UserPromptSubmit) {
    const originalLength = settings.hooks.UserPromptSubmit.length;

    // Remove new format (handles both 'grov prompt-inject' and '/path/to/grov prompt-inject')
    const newFormatFiltered = removeGrovCommands(settings.hooks.UserPromptSubmit, 'grov prompt-inject');

    // Also clean up old string format if present
    const cleaned = removeOldFormat(newFormatFiltered || [], 'grov prompt-inject') as HookEntry[];

    if (cleaned.length < originalLength) {
      removed.push('UserPromptSubmit → grov prompt-inject');
    }

    settings.hooks.UserPromptSubmit = cleaned.length > 0 ? cleaned : undefined;
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
