// Forward requests to Anthropic API using undici

import { request, Agent } from 'undici';

// Custom agent with longer connect timeout and better IPv4/IPv6 handling
const agent = new Agent({
  connect: {
    timeout: 30000, // 30s connect timeout
  },
  // autoSelectFamily helps when IPv6 isn't working properly
  autoSelectFamily: true,
  autoSelectFamilyAttemptTimeout: 500, // Try next address family after 500ms
});
import { config, buildSafeHeaders, maskSensitiveValue } from './config.js';
import type { AnthropicResponse, ContentBlock } from './action-parser.js';

/**
 * Parse SSE stream and reconstruct final message
 * SSE format: "event: <type>\ndata: <json>\n\n"
 */
function parseSSEResponse(sseText: string): AnthropicResponse | null {
  const lines = sseText.split('\n');

  let message: Partial<AnthropicResponse> | null = null;
  const contentBlocks: ContentBlock[] = [];
  const contentDeltas: Map<number, string[]> = new Map();
  let finalUsage: AnthropicResponse['usage'] | null = null;
  let stopReason: string | null = null;

  let currentEvent = '';
  let currentData = '';

  for (const line of lines) {
    if (line.startsWith('event: ')) {
      currentEvent = line.slice(7).trim();
    } else if (line.startsWith('data: ')) {
      currentData = line.slice(6);

      try {
        const data = JSON.parse(currentData);

        switch (data.type) {
          case 'message_start':
            // Initialize message from message_start event
            message = data.message;
            break;

          case 'content_block_start':
            // Add new content block - preserve ALL properties (including signature for thinking)
            if (data.content_block) {
              contentBlocks[data.index] = { ...data.content_block };
              if (data.content_block.type === 'text') {
                contentDeltas.set(data.index, []);
              } else if (data.content_block.type === 'thinking') {
                // Initialize thinking, preserve signature if present
                (contentBlocks[data.index] as { thinking: string }).thinking = '';
              }
            }
            break;

          case 'content_block_stop':
            // Capture signature for thinking blocks (comes at end of block)
            if (data.index !== undefined && contentBlocks[data.index]?.type === 'thinking') {
              if (data.signature) {
                (contentBlocks[data.index] as { signature?: string }).signature = data.signature;
              }
            }
            break;

          case 'content_block_delta':
            // Accumulate text deltas
            if (data.delta?.type === 'text_delta' && data.delta.text) {
              const deltas = contentDeltas.get(data.index) || [];
              deltas.push(data.delta.text);
              contentDeltas.set(data.index, deltas);
            } else if (data.delta?.type === 'thinking_delta' && data.delta.thinking) {
              // Handle thinking content
              const block = contentBlocks[data.index];
              if (block && block.type === 'thinking') {
                (block as { type: 'thinking'; thinking: string }).thinking += data.delta.thinking;
              }
            } else if (data.delta?.type === 'signature_delta' && data.delta.signature) {
              // Handle thinking signature streaming
              const block = contentBlocks[data.index];
              if (block && block.type === 'thinking') {
                const thinkingBlock = block as { type: 'thinking'; thinking: string; signature: string };
                thinkingBlock.signature = (thinkingBlock.signature || '') + data.delta.signature;
              }
            } else if (data.delta?.type === 'input_json_delta' && data.delta.partial_json) {
              // Handle tool input streaming
              const block = contentBlocks[data.index];
              if (block && block.type === 'tool_use') {
                // Accumulate partial JSON - will need to parse at the end
                const partialKey = `tool_partial_${data.index}`;
                const existing = contentDeltas.get(data.index) || [];
                existing.push(data.delta.partial_json);
                contentDeltas.set(data.index, existing);
              }
            }
            break;

          case 'message_delta':
            // Final usage and stop_reason
            if (data.usage) {
              finalUsage = data.usage;
            }
            if (data.delta?.stop_reason) {
              stopReason = data.delta.stop_reason;
            }
            break;
        }
      } catch {
        // Ignore unparseable data lines
      }
    }
  }

  if (!message) {
    return null;
  }

  // Reconstruct content blocks with accumulated text/input
  for (let i = 0; i < contentBlocks.length; i++) {
    const block = contentBlocks[i];
    if (!block) continue;

    const deltas = contentDeltas.get(i);
    if (deltas && deltas.length > 0) {
      if (block.type === 'text') {
        (block as { text: string }).text = deltas.join('');
      } else if (block.type === 'tool_use') {
        // Parse accumulated partial JSON for tool input
        try {
          const fullJson = deltas.join('');
          (block as { input: Record<string, unknown> }).input = JSON.parse(fullJson);
        } catch {
          // Keep original input if parsing fails
        }
      }
    }
  }

  // Build final response
  const response: AnthropicResponse = {
    id: message.id || '',
    type: 'message',
    role: 'assistant',
    content: contentBlocks.filter(Boolean),
    model: message.model || '',
    stop_reason: stopReason,
    stop_sequence: null,
    usage: finalUsage || message.usage || { input_tokens: 0, output_tokens: 0 },
  };

  return response;
}

export interface ForwardResult {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: AnthropicResponse | Record<string, unknown>;
  rawBody: string;
  wasSSE: boolean;  // True if response was SSE streaming
}

export interface ForwardError {
  type: 'timeout' | 'network' | 'parse' | 'unknown';
  message: string;
  statusCode?: number;
}

/**
 * Forward request to Anthropic API
 * Buffers full response for processing
 *
 * @param body - Parsed body for logging
 * @param headers - Request headers
 * @param logger - Optional logger
 * @param rawBody - Raw request bytes (preserves exact bytes for cache)
 */
export async function forwardToAnthropic(
  body: Record<string, unknown>,
  headers: Record<string, string | string[] | undefined>,
  logger?: { info: (msg: string, data?: Record<string, unknown>) => void; error: (msg: string, data?: Record<string, unknown>) => void },
  rawBody?: Buffer
): Promise<ForwardResult> {
  const targetUrl = `${config.ANTHROPIC_BASE_URL}/v1/messages`;
  const safeHeaders = buildSafeHeaders(headers);

  // Use raw bytes if available (preserves cache), otherwise re-serialize
  const requestBody = rawBody || JSON.stringify(body);

  // Log request (mask sensitive data)
  if (logger && config.LOG_REQUESTS) {
    const maskedHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(safeHeaders)) {
      maskedHeaders[key] = maskSensitiveValue(key, value);
    }
    logger.info('Forwarding to Anthropic', {
      url: targetUrl,
      model: body.model,
      messageCount: Array.isArray(body.messages) ? body.messages.length : 0,
      headers: maskedHeaders,
      usingRawBody: !!rawBody,
      bodySize: rawBody?.length || JSON.stringify(body).length,
    });
  }

  try {
    const response = await request(targetUrl, {
      method: 'POST',
      headers: {
        ...safeHeaders,
        'content-type': 'application/json',
      },
      body: requestBody,
      bodyTimeout: config.REQUEST_TIMEOUT,
      headersTimeout: config.REQUEST_TIMEOUT,
      dispatcher: agent,
    });

    // Buffer the full response
    const chunks: Buffer[] = [];
    for await (const chunk of response.body) {
      chunks.push(Buffer.from(chunk));
    }
    const rawBody = Buffer.concat(chunks).toString('utf-8');

    // Check if response is SSE streaming
    const contentType = response.headers['content-type'];
    const isSSE = typeof contentType === 'string' && contentType.includes('text/event-stream');

    // Parse response
    let parsedBody: AnthropicResponse | Record<string, unknown>;
    if (isSSE) {
      // Parse SSE and reconstruct final message
      const sseMessage = parseSSEResponse(rawBody);
      if (sseMessage) {
        parsedBody = sseMessage;
      } else {
        parsedBody = { error: 'Failed to parse SSE response', raw: rawBody.substring(0, 500) };
      }
    } else {
      // Regular JSON response
      try {
        parsedBody = JSON.parse(rawBody);
      } catch {
        parsedBody = { error: 'Invalid JSON response', raw: rawBody.substring(0, 500) };
      }
    }

    // Convert headers to record
    const responseHeaders: Record<string, string | string[]> = {};
    for (const [key, value] of Object.entries(response.headers)) {
      if (value !== undefined) {
        responseHeaders[key] = value;
      }
    }

    // If we parsed SSE, change content-type to JSON for Claude Code
    if (isSSE) {
      responseHeaders['content-type'] = 'application/json';
    }

    if (logger && config.LOG_REQUESTS) {
      logger.info('Received from Anthropic', {
        statusCode: response.statusCode,
        bodyLength: rawBody.length,
        hasUsage: 'usage' in parsedBody,
        wasSSE: isSSE,
        parseSuccess: !('error' in parsedBody),
      });
    }

    return {
      statusCode: response.statusCode,
      headers: responseHeaders,
      body: parsedBody,
      rawBody,
      wasSSE: isSSE,
    };
  } catch (error) {
    const err = error as Error & { code?: string };

    if (logger) {
      logger.error('Forward error', {
        message: err.message,
        code: err.code,
      });
    }

    // Handle specific error types
    if (err.code === 'UND_ERR_HEADERS_TIMEOUT' || err.code === 'UND_ERR_BODY_TIMEOUT') {
      throw createForwardError('timeout', 'Request to Anthropic timed out', 504);
    }

    if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
      throw createForwardError('network', 'Cannot connect to Anthropic API', 502);
    }

    if (err.code === 'ECONNRESET' || err.message?.includes('ECONNRESET')) {
      throw createForwardError('network', 'Connection reset by Anthropic API', 502);
    }

    if (err.code === 'UND_ERR_CONNECT_TIMEOUT' || err.message?.includes('Connect Timeout')) {
      throw createForwardError('timeout', 'Connection to Anthropic API timed out', 504);
    }

    throw createForwardError('unknown', err.message || 'Unknown error', 502);
  }
}

/**
 * Create a typed forward error
 */
function createForwardError(
  type: ForwardError['type'],
  message: string,
  statusCode?: number
): ForwardError {
  return { type, message, statusCode };
}

/**
 * Check if error is a ForwardError
 */
export function isForwardError(error: unknown): error is ForwardError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'type' in error &&
    'message' in error
  );
}
