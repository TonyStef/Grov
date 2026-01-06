// CLI Watcher - Polling orchestration for Cursor CLI capture
// Polls every 3 minutes while MCP connection is active

import { homedir } from 'os';
import { join } from 'path';
import { readdirSync, existsSync, statSync } from 'fs';

const CLI_CHATS_PATH = join(homedir(), '.cursor', 'chats');
const POLL_INTERVAL = 3 * 60 * 1000; // 3 minutes

let pollingInterval: ReturnType<typeof setInterval> | null = null;
let pollFunction: (() => Promise<void>) | null = null;

/**
 * Start CLI capture polling
 * Returns cleanup function to stop polling
 */
export function startCLICapture(pollAndCapture: () => Promise<void>): () => void {
  pollFunction = pollAndCapture;

  // Initial poll (delayed slightly to let MCP fully connect)
  setTimeout(() => {
    pollAndCapture().catch(() => {});
  }, 5000);

  // Start interval
  pollingInterval = setInterval(() => {
    pollAndCapture().catch(() => {});
  }, POLL_INTERVAL);

  // Return cleanup function
  return () => {
    if (pollFunction) {
      pollFunction().catch(() => {});
    }
    if (pollingInterval) {
      clearInterval(pollingInterval);
      pollingInterval = null;
    }
    pollFunction = null;
  };
}

/**
 * Find all CLI databases (not just most recent)
 * Returns array of { dbPath, agentId, mtime }
 */
export function findAllCLIDatabases(): Array<{ dbPath: string; workspaceHash: string; agentId: string; mtime: number }> {
  if (!existsSync(CLI_CHATS_PATH)) {
    return [];
  }

  const databases: Array<{ dbPath: string; workspaceHash: string; agentId: string; mtime: number }> = [];

  try {
    for (const workspaceHash of readdirSync(CLI_CHATS_PATH)) {
      const wsPath = join(CLI_CHATS_PATH, workspaceHash);

      // Skip if not a directory
      try {
        if (!statSync(wsPath).isDirectory()) continue;
      } catch {
        continue;
      }

      for (const agentId of readdirSync(wsPath)) {
        const dbPath = join(wsPath, agentId, 'store.db');

        if (existsSync(dbPath)) {
          try {
            const stat = statSync(dbPath);
            databases.push({
              dbPath,
              workspaceHash,
              agentId,
              mtime: stat.mtimeMs
            });
          } catch {
            // Skip inaccessible files
          }
        }
      }
    }
  } catch {
    // Ignore scan errors
  }

  // Sort by most recent first
  return databases.sort((a, b) => b.mtime - a.mtime);
}

/**
 * Find most recently modified CLI database
 */
export function findMostRecentCLIDatabase(): { dbPath: string; agentId: string } | null {
  const all = findAllCLIDatabases();
  if (all.length === 0) return null;
  return { dbPath: all[0].dbPath, agentId: all[0].agentId };
}

/**
 * Check if CLI chats directory exists
 */
export function cliChatsExist(): boolean {
  return existsSync(CLI_CHATS_PATH);
}

/**
 * Get the CLI chats path (for debugging/logging)
 */
export function getCLIChatsPath(): string {
  return CLI_CHATS_PATH;
}
