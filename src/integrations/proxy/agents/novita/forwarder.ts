import { request, Agent } from 'undici';
import { config } from '../../config.js';
import type { NovitaResponse, NovitaToolCall } from './types.js';

const NOVITA_BASE_URL = 'https://api.novita.ai/openai';

const NOVITA_FORWARD_HEADERS = [
  'x-api-key',
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

export interface NovitaForwardResult {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: NovitaResponse | Record<string, unknown>;
  rawBody: string;
  wasSSE: boolean;
}

export async function forwardToNovita(
  body: Record<string, unknown>,
  headers: Record<string, string | string[] | undefined>,
  rawBody?: Buffer
): Promise<NovitaForwardResult> {
  const targetUrl = `${NOVITA_BASE_URL}/v1/chat/completions`;
  const safeHeaders = buildNovitaHeaders(headers);

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

  let parsedBody: NovitaResponse | Record<string, unknown>;
  if (isSSE) {
    const sseResponse = parseNovitaSSE(responseRawBody);
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

function buildNovitaHeaders(
  headers: Record<string, string | string[] | undefined>
): Record<string, string> {
  const result: Record<string, string> = {};

  const lowerHeaders: Record<string, string | string[] | undefined> = {};
  for (const [key, value] of Object.entries(headers)) {
    lowerHeaders[key.toLowerCase()] = value;
  }

  for (const header of NOVITA_FORWARD_HEADERS) {
    const value = lowerHeaders[header.toLowerCase()];
    if (value) {
      result[header] = Array.isArray(value) ? value[0] : value;
    }
  }

  return result;
}

function parseNovitaSSE(sseText: string): NovitaResponse | null {
  let response: Partial<NovitaResponse> | null = null;
  const choices: Array<{ index: number; message: { role: string; content: string; tool_calls?: NovitaToolCall[] }; finish_reason?: string }> = [];

  for (const line of sseText.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const dataStr = line.slice(6);
    if (dataStr === '[DONE]') continue;

    try {
      const data = JSON.parse(dataStr);

      if (data.object === 'chat.completion') {
        return {
          id: data.id,
          object: data.object,
          created: data.created,
          model: data.model,
          choices: data.choices || [],
          usage: data.usage,
        };
      }

      if (data.object === 'chat.completion.chunk' && data.choices) {
        for (const choice of data.choices) {
          const index = choice.index;
          if (index !== undefined) {
            if (!choices[index]) {
              choices[index] = { index, message: { role: 'assistant', content: '' } };
            }
            if (choice.delta?.content) {
              choices[index].message.content += choice.delta.content;
            }
            if (choice.delta?.tool_calls) {
              const toolCalls = choice.delta.tool_calls as NovitaToolCall[];
              if (!choices[index].message.tool_calls) {
                choices[index].message.tool_calls = [];
              }
              for (const toolCall of toolCalls) {
                choices[index].message.tool_calls.push(toolCall);
              }
            }
            if (choice.finish_reason) {
              choices[index].finish_reason = choice.finish_reason;
            }
          }
        }
      }
    } catch {
      continue;
    }
  }

  return null;
}
