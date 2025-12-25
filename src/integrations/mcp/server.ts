// MCP Server Configuration
// Registers grov tools: preview, expand, save, decide-update

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { handlePreview } from './tools/preview.js';
import { handleExpand } from './tools/expand.js';
import { handleSave } from './tools/save.js';
import { handleDecideUpdate } from './tools/decide-update.js';
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
    'Fetch relevant memories based on context. Call this at the START of every conversation before any other action.',
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
    'Get full details for memories by index. Call after grov_preview to expand relevant memories.',
    {
      indices: z.array(z.number()).describe('1-based indices from preview to expand'),
    },
    async (args) => {
      mcpLog('grov_expand called', { indices: args.indices });
      try {
        const result = await handleExpand(args.indices);
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

  // ─────────────────────────────────────────────────────────────
  // grov_save - Save work to team memory
  // ─────────────────────────────────────────────────────────────
  server.tool(
    'grov_save',
    'Save completed work to team memory. Call when you finish the user\'s request.',
    {
      goal: z.string().max(150).describe('What was accomplished (max 150 chars)'),
      original_query: z.string().describe('The user\'s original request'),
      summary: z.string().max(200).describe('Brief description for search (max 200 chars)'),
      reasoning_trace: z.array(z.object({
        conclusion: z.string().max(150).describe('Specific factual finding'),
        insight: z.string().max(150).describe('Why it matters'),
      })).max(5).describe('Key findings (max 5)'),
      decisions: z.array(z.object({
        choice: z.string().max(100).describe('What was decided'),
        reason: z.string().max(150).describe('Why'),
      })).max(5).describe('Significant decisions (max 5)'),
      files_touched: z.array(z.string()).describe('Files read or modified'),
      mode: z.enum(['agent', 'planning', 'ask']).describe('Current Cursor mode'),
    },
    async (args) => {
      mcpLog('grov_save called', { goal: args.goal, mode: args.mode, filesCount: args.files_touched.length });
      try {
        const result = await handleSave({
          goal: args.goal,
          original_query: args.original_query,
          summary: args.summary,
          reasoning_trace: args.reasoning_trace,
          decisions: args.decisions,
          files_touched: args.files_touched,
          mode: args.mode,
        });
        mcpLog('grov_save success', { resultLength: result.length });
        return {
          content: [{ type: 'text', text: result }],
        };
      } catch (err) {
        mcpError('grov_save failed', err);
        throw err;
      }
    }
  );

  // ─────────────────────────────────────────────────────────────
  // grov_decide_update - Decide whether to update existing memory
  // ─────────────────────────────────────────────────────────────
  server.tool(
    'grov_decide_update',
    'Decide whether to UPDATE or SKIP an existing memory. Only call when grov_save returns needs_decision: true.',
    {
      decision: z.enum(['update', 'skip']).describe('Whether to update the matched memory'),
      reason: z.string().describe('Brief explanation of the decision'),
    },
    async (args) => {
      mcpLog('grov_decide_update called', { decision: args.decision, reason: args.reason });
      try {
        const result = await handleDecideUpdate(args.decision, args.reason);
        mcpLog('grov_decide_update success', { resultLength: result.length });
        return {
          content: [{ type: 'text', text: result }],
        };
      } catch (err) {
        mcpError('grov_decide_update failed', err);
        throw err;
      }
    }
  );

  mcpLog('Server created with 4 tools registered');
  return server;
}
