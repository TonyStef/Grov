import type { NovitaRequestBody, NovitaToolCall } from './types.js';

export function extractProjectPath(body: NovitaRequestBody): string | null {
  for (const msg of body.messages || []) {
    if ('role' in msg && msg.role === 'user') {
      const content = typeof msg.content === 'string' ? msg.content : Array.isArray(msg.content) ? msg.content.map(c => (c as { text?: string }).text).join('\n') : '';
      const match = content.match(/project\s*(path|directory|folder)?\s*[:\s]+([^\s\n]+)/i);
      if (match) {
        return match[2];
      }
    }
  }
  return null;
}

export function extractSessionId(response: unknown): string | null {
  const novitaResponse = response as { id?: string };
  return novitaResponse.id || null;
}

export function extractTextContent(response: unknown): string {
  const novitaResponse = response as { choices?: Array<{ message?: { content?: string; tool_calls?: NovitaToolCall[] } }> };
  const textParts: string[] = [];

  if (novitaResponse.choices) {
    for (const choice of novitaResponse.choices) {
      if (choice.message?.content) {
        textParts.push(choice.message.content);
      }
      if (choice.message?.tool_calls) {
        for (const toolCall of choice.message.tool_calls) {
          textParts.push(toolCall.function.arguments);
        }
      }
    }
  }

  return textParts.join('\n');
}

export function extractGoalFromMessages(messages: NovitaRequestBody['messages']): string {
  if (!messages) return '';

  for (const msg of messages) {
    if ('role' in msg && msg.role === 'user') {
      if (typeof msg.content === 'string') {
        return msg.content;
      }
      if (Array.isArray(msg.content)) {
        return msg.content.map(c => typeof c === 'string' ? c : (c as { text?: string }).text).join('\n');
      }
    }
  }

  return '';
}

export function extractConversationHistory(messages: NovitaRequestBody['messages']): Array<{ role: string; content: string }> {
  const result: Array<{ role: string; content: string }> = [];
  
  if (!messages) return result;
  
  for (const msg of messages) {
    if ('role' in msg) {
      const role = msg.role;
      if (role === 'user' || role === 'assistant') {
        let content = typeof msg.content === 'string' ? msg.content : Array.isArray(msg.content) 
          ? msg.content.map(c => typeof c === 'string' ? c : (c as { text?: string }).text).join('\n') 
          : '';
        result.push({ role, content });
      }
    }
  }
  
  return result;
}
