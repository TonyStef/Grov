// MCP Server Entry Point
// Starts the Grov MCP server for Cursor integration
// Uses stdio transport for communication with Cursor

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';
import { mcpLog, mcpError } from './logger.js';

/**
 * Start the MCP server
 * Called by Cursor via: grov mcp serve
 */
export async function startMcpServer(): Promise<void> {
  mcpLog('Starting MCP server', {
    cwd: process.cwd(),
    pid: process.pid,
    workspace: process.env.WORKSPACE_FOLDER_PATHS
  });

  // Create and connect server
  const server = createServer();
  const transport = new StdioServerTransport();

  await server.connect(transport);
  mcpLog('Server connected via stdio transport');

  // Handle clean shutdown
  process.on('SIGINT', async () => {
    mcpLog('Received SIGINT, shutting down');
    await server.close();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    mcpLog('Received SIGTERM, shutting down');
    await server.close();
    process.exit(0);
  });
}

// If run directly (e.g., via grov mcp serve)
if (import.meta.url === `file://${process.argv[1]}`) {
  startMcpServer().catch((err) => {
    mcpError('MCP server fatal error', err);
    process.exit(1);
  });
}
