// Claude-specific extraction functions

import type { AnthropicResponse } from './parser.js';
import type { ConversationMessage } from '../../../../core/extraction/llm-extractor.js';
import type { MessagesRequestBody } from '../../types.js';

export function extractTextContent(response: AnthropicResponse): string {
  return response.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map(block => block.text)
    .join('\n');
}

export function extractProjectPath(body: MessagesRequestBody): string | null {
  let systemPrompt = '';
  if (typeof body.system === 'string') {
    systemPrompt = body.system;
  } else if (Array.isArray(body.system)) {
    systemPrompt = body.system
      .filter((block): block is { type: string; text: string } =>
        block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
      .map(block => block.text)
      .join('\n');
  }
  const cwdMatch = systemPrompt.match(/Working directory:\s*([^\n]+)/);
  if (cwdMatch) {
    return cwdMatch[1].trim();
  }
  return null;
}

export function extractSessionId(response: AnthropicResponse): string | null {
  return response.id || null;
}

export function extractGoalFromMessages(messages: Array<{ role: string; content: unknown }>): string | undefined {
  const userMessages = messages?.filter(m => m.role === 'user') || [];

  for (const userMsg of [...userMessages].reverse()) {
    let rawContent = '';

    if (typeof userMsg.content === 'string') {
      rawContent = userMsg.content;
    }

    if (Array.isArray(userMsg.content)) {
      const textBlocks = userMsg.content
        .filter((block): block is { type: string; text: string } =>
          block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
        .map(block => block.text);
      rawContent = textBlocks.join('\n');
    }

    const cleanContent = rawContent
      .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
      .replace(/<\/system-reminder>/g, '')
      .replace(/<system-reminder>[^<]*/g, '')
      .trim();

    if (cleanContent && cleanContent.length >= 5) {
      return cleanContent.substring(0, 500);
    }
  }

  return undefined;
}

export function extractConversationHistory(
  messages: Array<{ role: string; content: unknown }>
): ConversationMessage[] {
  if (!messages || messages.length === 0) return [];

  const result: ConversationMessage[] = [];

  for (const msg of messages.slice(-10)) {
    if (msg.role !== 'user' && msg.role !== 'assistant') continue;

    let textContent = '';

    if (typeof msg.content === 'string') {
      textContent = msg.content;
    }

    if (Array.isArray(msg.content)) {
      const textBlocks = msg.content
        .filter((block): block is { type: string; text: string } =>
          block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
        .map(block => block.text);
      textContent = textBlocks.join('\n');
    }

    const cleanContent = textContent
      .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
      .trim();

    if (cleanContent && cleanContent.length > 0) {
      result.push({
        role: msg.role as 'user' | 'assistant',
        content: cleanContent,
      });
    }
  }

  return result;
}
