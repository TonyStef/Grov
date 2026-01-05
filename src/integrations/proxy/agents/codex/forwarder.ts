// Forward requests to OpenAI API

import { request, Agent } from 'undici';
import { config } from '../../config.js';
import type { CodexResponse, CodexOutputItem } from './types.js';

const OPENAI_BASE_URL = 'https://api.openai.com';

const OPENAI_FORWARD_HEADERS = [
  'authorization',
  'openai-organization',
  'openai-project',
  'openai-beta',
];

const agent = new Agent({
  connect: { timeout: 30000 },
  autoSelectFamily: true,
  autoSelectFamilyAttemptTimeout: 500,
});

export interface CodexForwardResult {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: CodexResponse | Record<string, unknown>;
  rawBody: string;
  wasSSE: boolean;
}

export async function forwardToOpenAI(
  body: Record<string, unknown>,
  headers: Record<string, string | string[] | undefined>,
  rawBody?: Buffer
): Promise<CodexForwardResult> {
  const targetUrl = `${OPENAI_BASE_URL}/v1/responses`;
  const safeHeaders = buildOpenAIHeaders(headers);

  const requestBody = rawBody || JSON.stringify(body);

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

  const chunks: Buffer[] = [];
  for await (const chunk of response.body) {
    chunks.push(Buffer.from(chunk));
  }
  const responseRawBody = Buffer.concat(chunks).toString('utf-8');

  const contentType = response.headers['content-type'];
  const isSSE = typeof contentType === 'string' && contentType.includes('text/event-stream');

  let parsedBody: CodexResponse | Record<string, unknown>;
  if (isSSE) {
    const sseResponse = parseOpenAISSE(responseRawBody);
    parsedBody = sseResponse || { error: 'Failed to parse SSE response' };
  } else {
    try {
      parsedBody = JSON.parse(responseRawBody);
    } catch {
      parsedBody = { error: 'Invalid JSON response' };
    }
  }

  const responseHeaders: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(response.headers)) {
    if (value !== undefined) {
      responseHeaders[key] = value;
    }
  }

  if (isSSE) {
    responseHeaders['content-type'] = 'application/json';
  }

  return {
    statusCode: response.statusCode,
    headers: responseHeaders,
    body: parsedBody,
    rawBody: responseRawBody,
    wasSSE: isSSE,
  };
}

function buildOpenAIHeaders(
  headers: Record<string, string | string[] | undefined>
): Record<string, string> {
  const result: Record<string, string> = {};

  const lowerHeaders: Record<string, string | string[] | undefined> = {};
  for (const [key, value] of Object.entries(headers)) {
    lowerHeaders[key.toLowerCase()] = value;
  }

  for (const header of OPENAI_FORWARD_HEADERS) {
    const value = lowerHeaders[header.toLowerCase()];
    if (value) {
      result[header] = Array.isArray(value) ? value[0] : value;
    }
  }

  return result;
}

function parseOpenAISSE(sseText: string): CodexResponse | null {
  let response: Partial<CodexResponse> | null = null;
  const output: CodexOutputItem[] = [];

  for (const line of sseText.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const dataStr = line.slice(6);
    if (dataStr === '[DONE]') continue;

    try {
      const data = JSON.parse(dataStr);

      if (data.type === 'response.created') {
        response = {
          id: data.response?.id,
          status: 'in_progress',
          output: [],
        };
      }

      if (data.type === 'response.output_item.done' && data.item) {
        output.push(data.item);
      }

      if (data.type === 'response.completed' && data.response) {
        return {
          id: data.response.id,
          status: data.response.status,
          output: data.response.output || output,
          usage: data.response.usage,
        };
      }
    } catch {
      continue;
    }
  }

  if (response) {
    return {
      id: response.id || '',
      status: 'completed',
      output,
      usage: response.usage,
    };
  }

  return null;
}
