// MCP Server Configuration
// Registers grov tools: preview, expand (injection only)
// Capture is handled by stop hook → capture/hook-handler.ts

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { handlePreview } from './tools/preview.js';
import { handleExpand } from './tools/expand.js';
import { mcpLog, mcpError } from './logger.js';

/**
 * Create and configure the MCP server with all grov tools
 */
export function createServer(): McpServer {
  const server = new McpServer({
    name: 'grov',
    version: '1.0.0',
  });

  // ─────────────────────────────────────────────────────────────
  // grov_preview - Fetch relevant memories at conversation start
  // ─────────────────────────────────────────────────────────────
  server.tool(
    'grov_preview',
    'MANDATORY first action at EVERY prompt. Results vary per prompt context - previous empty result does NOT mean current will be empty. Must call before any other tool.',
    {
      context: z.string().describe('The user\'s question or request'),
      mode: z.enum(['agent', 'planning', 'ask']).describe('Current Cursor mode'),
    },
    async (args) => {
      mcpLog('grov_preview called', { context: args.context.substring(0, 100), mode: args.mode });
      try {
        const result = await handlePreview(args.context, args.mode);
        mcpLog('grov_preview success', { resultLength: result.length });
        return {
          content: [{ type: 'text', text: result }],
        };
      } catch (err) {
        mcpError('grov_preview failed', err);
        throw err;
      }
    }
  );

  // ─────────────────────────────────────────────────────────────
  // grov_expand - Get full details for specific memories
  // ─────────────────────────────────────────────────────────────
  server.tool(
    'grov_expand',
    'Get YOUR verified knowledge for THE ONE most relevant memory. After expand: PINPOINT what you EDIT + IMPORT for THIS task. Read ONLY those files. KB already gave you context.',
    {
      id: z.string().describe('Memory ID (8-char) from preview - THE ONE most relevant for this task'),
    },
    async (args) => {
      mcpLog('grov_expand called', { id: args.id });
      try {
        const result = await handleExpand(args.id);
        mcpLog('grov_expand success', { resultLength: result.length });
        return {
          content: [{ type: 'text', text: result }],
        };
      } catch (err) {
        mcpError('grov_expand failed', err);
        throw err;
      }
    }
  );

  mcpLog('Server created with 2 tools registered (preview, expand)');
  return server;
}
