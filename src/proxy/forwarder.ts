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
import type { AnthropicResponse } from './action-parser.js';

export interface ForwardResult {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: AnthropicResponse | Record<string, unknown>;
  rawBody: string;
}

export interface ForwardError {
  type: 'timeout' | 'network' | 'parse' | 'unknown';
  message: string;
  statusCode?: number;
}

/**
 * Forward request to Anthropic API
 * Buffers full response for processing
 */
export async function forwardToAnthropic(
  body: Record<string, unknown>,
  headers: Record<string, string | string[] | undefined>,
  logger?: { info: (msg: string, data?: Record<string, unknown>) => void; error: (msg: string, data?: Record<string, unknown>) => void }
): Promise<ForwardResult> {
  const targetUrl = `${config.ANTHROPIC_BASE_URL}/v1/messages`;
  const safeHeaders = buildSafeHeaders(headers);

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
    });
  }

  try {
    const response = await request(targetUrl, {
      method: 'POST',
      headers: {
        ...safeHeaders,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
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

    // Parse response
    let parsedBody: AnthropicResponse | Record<string, unknown>;
    try {
      parsedBody = JSON.parse(rawBody);
    } catch {
      // Return raw body if not JSON
      parsedBody = { error: 'Invalid JSON response', raw: rawBody.substring(0, 500) };
    }

    // Convert headers to record
    const responseHeaders: Record<string, string | string[]> = {};
    for (const [key, value] of Object.entries(response.headers)) {
      if (value !== undefined) {
        responseHeaders[key] = value;
      }
    }

    if (logger && config.LOG_REQUESTS) {
      logger.info('Received from Anthropic', {
        statusCode: response.statusCode,
        bodyLength: rawBody.length,
        hasUsage: 'usage' in parsedBody,
      });
    }

    return {
      statusCode: response.statusCode,
      headers: responseHeaders,
      body: parsedBody,
      rawBody,
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
