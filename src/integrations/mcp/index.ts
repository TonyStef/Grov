// MCP Server Entry Point
// Starts the Grov MCP server for Cursor integration
// Uses stdio transport for communication with Cursor

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';
import { mcpLog, mcpError } from './logger.js';
import { startCLICapture, cliChatsExist } from './capture/cli-watcher.js';
import { pollAndCaptureAll } from './capture/cli-extractor.js';
import { isCLICaptureEnabled } from './capture/cli-transform.js';

// Cleanup function for CLI capture polling
let stopCLICapture: (() => void) | null = null;

/**
 * Detect if we're running in IDE or CLI context
 *
 * Logic:
 * - If WORKSPACE_FOLDER_PATHS is set → IDE (always set when IDE has a project open)
 * - If not set but running from terminal (TERM/PROMPT) → CLI
 * - If not set and not from terminal → IDE without project
 *
 * Edge case: IDE opened from terminal without project → detected as CLI (harmless)
 */
function detectContext(): 'IDE' | 'CLI' {
  // If workspace is set, it's definitely IDE
  if (process.env.WORKSPACE_FOLDER_PATHS) {
    return 'IDE';
  }

  // Check if running from terminal (OS-agnostic)
  const isWindows = process.platform === 'win32';
  const hasTerminal = isWindows
    ? !!(process.env.PROMPT || process.env.WT_SESSION)  // Windows CMD or Windows Terminal
    : !!process.env.TERM;                                // Linux/macOS

  // No workspace + has terminal = CLI
  // No workspace + no terminal = IDE without project
  return hasTerminal ? 'CLI' : 'IDE';
}

export async function startMcpServer(): Promise<void> {
  // Detect if running from IDE or CLI
  const context = detectContext();
  const isIDE = context === 'IDE';

  mcpLog('Starting MCP server', { detectedContext: context });

  // Create and connect server
  const server = createServer();
  const transport = new StdioServerTransport();

  await server.connect(transport);

  // Start CLI capture polling ONLY if in CLI context (not IDE)
  // IDE uses hooks for capture, CLI uses polling
  if (!isIDE && isCLICaptureEnabled() && cliChatsExist()) {
    stopCLICapture = startCLICapture(pollAndCaptureAll);
  }

  // Handle clean shutdown
  let isShuttingDown = false;
  const cleanup = async () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    if (stopCLICapture) stopCLICapture();
    await server.close();
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  process.stdin.on('end', cleanup);
  process.stdin.on('close', cleanup);
  process.on('disconnect', cleanup);
}

// If run directly (e.g., via grov mcp serve)
if (import.meta.url === `file://${process.argv[1]}`) {
  startMcpServer().catch((err) => {
    mcpError('MCP server fatal error', err);
    process.exit(1);
  });
}
