// Pure extraction functions for parsing request/response data

import type { AnthropicResponse } from '../action-parser.js';
import type { ConversationMessage } from '../../lib/llm-extractor.js';
import type { MessagesRequestBody } from '../types.js';

export function detectKeyDecision(
  action: { actionType: string; files: string[]; command?: string },
  reasoning: string
): boolean {
  // Code modifications are always key decisions
  if (action.actionType === 'edit' || action.actionType === 'write') {
    return true;
  }

  // Check for decision-related keywords in reasoning
  const decisionKeywords = [
    'decision', 'decided', 'chose', 'chosen', 'selected', 'picked',
    'approach', 'strategy', 'solution', 'implementation',
    'because', 'reason', 'rationale', 'trade-off', 'tradeoff',
    'instead of', 'rather than', 'prefer', 'opted',
    'conclusion', 'determined', 'resolved'
  ];

  const reasoningLower = reasoning.toLowerCase();
  const hasDecisionKeyword = decisionKeywords.some(kw => reasoningLower.includes(kw));

  // Substantial reasoning (>200 chars) with decision keyword = key decision
  if (hasDecisionKeyword && reasoning.length > 200) {
    return true;
  }

  return false;
}

export function extractTextContent(response: AnthropicResponse): string {
  return response.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map(block => block.text)
    .join('\n');
}

export function extractProjectPath(body: MessagesRequestBody): string | null {
  // Try to extract from system prompt or messages
  // Handle both string and array format for system prompt
  let systemPrompt = '';
  if (typeof body.system === 'string') {
    systemPrompt = body.system;
  } else if (Array.isArray(body.system)) {
    // New API format: system is array of {type: 'text', text: '...'}
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

export function extractGoalFromMessages(messages: Array<{ role: string; content: unknown }>): string | undefined {
  const userMessages = messages?.filter(m => m.role === 'user') || [];

  // Iterate in REVERSE to get the LAST (most recent) user message
  for (const userMsg of [...userMessages].reverse()) {
    let rawContent = '';

    // Handle string content
    if (typeof userMsg.content === 'string') {
      rawContent = userMsg.content;
    }

    // Handle array content - look for text blocks (skip tool_result)
    if (Array.isArray(userMsg.content)) {
      const textBlocks = userMsg.content
        .filter((block): block is { type: string; text: string } =>
          block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
        .map(block => block.text);
      rawContent = textBlocks.join('\n');
    }

    // Remove <system-reminder>...</system-reminder> tags (including orphaned tags from split content blocks)
    const cleanContent = rawContent
      .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
      .replace(/<\/system-reminder>/g, '')
      .replace(/<system-reminder>[^<]*/g, '')
      .trim();

    // If we found valid text content, return it
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

    // Handle string content
    if (typeof msg.content === 'string') {
      textContent = msg.content;
    }

    // Handle array content - extract text blocks only
    if (Array.isArray(msg.content)) {
      const textBlocks = msg.content
        .filter((block): block is { type: string; text: string } =>
          block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
        .map(block => block.text);
      textContent = textBlocks.join('\n');
    }

    // Remove system-reminder tags
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
