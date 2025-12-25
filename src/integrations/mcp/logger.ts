// MCP Logger - writes to mcp-cursor.log in project root
// Uses file logging because stdout is reserved for JSON-RPC

import { appendFileSync, writeFileSync } from 'fs';
import { join } from 'path';

// Log file in project root (cwd when MCP starts)
const LOG_FILE = join(process.cwd(), 'mcp-cursor.log');

// Clear log on startup
let initialized = false;

function ensureInitialized() {
  if (!initialized) {
    try {
      writeFileSync(LOG_FILE, `=== MCP Server Started ${new Date().toISOString()} ===\n`);
      initialized = true;
    } catch {
      // Ignore write errors
    }
  }
}

/**
 * Log a message to mcp-cursor.log
 */
export function mcpLog(message: string, data?: unknown): void {
  ensureInitialized();

  const timestamp = new Date().toISOString();
  let line = `[${timestamp}] ${message}`;

  if (data !== undefined) {
    try {
      line += ` ${JSON.stringify(data, null, 2)}`;
    } catch {
      line += ` [unserializable data]`;
    }
  }

  try {
    appendFileSync(LOG_FILE, line + '\n');
  } catch {
    // Ignore write errors silently
  }
}

/**
 * Log an error
 */
export function mcpError(message: string, error?: unknown): void {
  const errorInfo = error instanceof Error
    ? { message: error.message, stack: error.stack }
    : error;
  mcpLog(`ERROR: ${message}`, errorInfo);
}
