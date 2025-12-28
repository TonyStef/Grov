// Codex-specific extraction functions

import type { CodexRequestBody, CodexResponse, CodexInputItem } from './types.js';
import type { ConversationMessage } from '../../../../core/extraction/llm-extractor.js';

const CWD_REGEX = /<cwd>(.+?)<\/cwd>/;

function getContentText(content: string | Array<{ type: string; text?: string }>): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(c => (typeof c === 'string' ? c : c.text || ''))
      .join('\n');
  }
  return '';
}

export function extractProjectPath(body: CodexRequestBody): string | null {
  for (const item of body.input) {
    if ('content' in item) {
      const text = getContentText(item.content);
      const match = text.match(CWD_REGEX);
      if (match) return match[1];
    }
  }
  return null;
}

export function extractSessionId(response: CodexResponse): string | null {
  return response.id || null;
}

export function extractGoalFromMessages(input: CodexInputItem[]): string | undefined {
  const userItems = input.filter(
    (item): item is { role: 'user'; content: string | Array<{ type: string; text?: string }> } =>
      'role' in item && item.role === 'user'
  );

  for (const item of [...userItems].reverse()) {
    const text = getContentText(item.content);
    const cleaned = text.replace(/<[^>]+>[^<]*<\/[^>]+>/g, '').trim();

    if (cleaned.length >= 5) {
      return cleaned.substring(0, 500);
    }
  }

  return undefined;
}

export function extractConversationHistory(input: CodexInputItem[]): ConversationMessage[] {
  const result: ConversationMessage[] = [];

  const messageItems = input.filter(
    (item): item is { role: 'user' | 'assistant'; content: string | Array<{ type: string; text?: string }> } =>
      'role' in item && (item.role === 'user' || item.role === 'assistant')
  );

  for (const item of messageItems.slice(-10)) {
    const text = getContentText(item.content);
    const cleaned = text.replace(/<[^>]+>[^<]*<\/[^>]+>/g, '').trim();

    if (cleaned.length > 0) {
      result.push({ role: item.role, content: cleaned });
    }
  }

  return result;
}
