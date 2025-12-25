// Injection helpers for modifying request bodies

import type { MessagesRequestBody } from '../types.js';

/**
 * Inject a tool definition into the raw JSON body's "tools" array.
 * This preserves the original byte sequence for cache consistency.
 */
export function injectToolIntoRawBody(rawBody: string, toolDef: object): { modified: string; success: boolean } {
  // Find the tools array in the raw JSON
  // Pattern: "tools": [...]
  const toolsMatch = rawBody.match(/"tools"\s*:\s*\[/);
  if (!toolsMatch || toolsMatch.index === undefined) {
    // No tools array found - need to add one
    // Find a good insertion point (before "messages" or at end of object)
    const messagesMatch = rawBody.match(/"messages"\s*:/);
    if (messagesMatch && messagesMatch.index !== undefined) {
      // Insert tools array before messages
      const toolsJson = JSON.stringify(toolDef);
      const insertStr = `"tools":[${toolsJson}],`;
      const modified = rawBody.slice(0, messagesMatch.index) + insertStr + rawBody.slice(messagesMatch.index);
      return { modified, success: true };
    }
    return { modified: rawBody, success: false };
  }

  // Find the matching closing bracket for the tools array
  const startIndex = toolsMatch.index + toolsMatch[0].length;
  let bracketCount = 1;
  let endIndex = startIndex;

  for (let i = startIndex; i < rawBody.length && bracketCount > 0; i++) {
    const char = rawBody[i];
    if (char === '[') bracketCount++;
    else if (char === ']') bracketCount--;
    else if (char === '"') {
      // Skip string content
      i++;
      while (i < rawBody.length && rawBody[i] !== '"') {
        if (rawBody[i] === '\\') i++;
        i++;
      }
    }
    if (bracketCount === 0) {
      endIndex = i;
      break;
    }
  }

  if (bracketCount !== 0) {
    return { modified: rawBody, success: false };
  }

  // Serialize the tool definition
  const toolJson = JSON.stringify(toolDef);

  // Check if array is empty (only whitespace between [ and ])
  const arrayContent = rawBody.slice(startIndex, endIndex).trim();
  const separator = arrayContent.length > 0 ? ',' : '';

  // Insert before the closing bracket
  const modified = rawBody.slice(0, endIndex) + separator + toolJson + rawBody.slice(endIndex);

  return { modified, success: true };
}

export function appendToLastUserMessage(rawBody: string, injection: string): string {
  // Find the last occurrence of "role":"user" followed by content
  // We need to find the content field of the last user message and append to it

  // Strategy: Find all user messages, get the last one, append to its content
  // This is tricky because content can be string or array

  // Simpler approach: Find the last user message's closing content
  // Look for pattern: "role":"user","content":"..." or "role":"user","content":[...]

  // Find last "role":"user"
  const userRolePattern = /"role"\s*:\s*"user"/g;
  let lastUserMatch: RegExpExecArray | null = null;
  let match;

  while ((match = userRolePattern.exec(rawBody)) !== null) {
    lastUserMatch = match;
  }

  if (!lastUserMatch) {
    // No user message found, can't inject
    return rawBody;
  }

  // From lastUserMatch position, find the content field
  const afterRole = rawBody.slice(lastUserMatch.index);

  // Find "content" field after role
  const contentMatch = afterRole.match(/"content"\s*:\s*/);
  if (!contentMatch || contentMatch.index === undefined) {
    return rawBody;
  }

  const contentStartGlobal = lastUserMatch.index + contentMatch.index + contentMatch[0].length;
  const afterContent = rawBody.slice(contentStartGlobal);

  // Determine if content is string or array
  if (afterContent.startsWith('"')) {
    // String content - find closing quote (handling escapes)
    let i = 1; // Skip opening quote
    while (i < afterContent.length) {
      if (afterContent[i] === '\\') {
        i += 2; // Skip escaped char
      } else if (afterContent[i] === '"') {
        // Found closing quote
        const insertPos = contentStartGlobal + i;
        // Insert before closing quote, escape the injection for JSON
        const escapedInjection = injection
          .replace(/\\/g, '\\\\')
          .replace(/"/g, '\\"')
          .replace(/\n/g, '\\n');
        return rawBody.slice(0, insertPos) + '\\n\\n' + escapedInjection + rawBody.slice(insertPos);
      } else {
        i++;
      }
    }
  } else if (afterContent.startsWith('[')) {
    // Array content - find last text block and append, or add new text block
    // Find the closing ] of the content array
    let depth = 1;
    let i = 1;

    while (i < afterContent.length && depth > 0) {
      const char = afterContent[i];
      if (char === '[') depth++;
      else if (char === ']') depth--;
      else if (char === '"') {
        // Skip string
        i++;
        while (i < afterContent.length && afterContent[i] !== '"') {
          if (afterContent[i] === '\\') i++;
          i++;
        }
      }
      i++;
    }

    if (depth === 0) {
      // Found closing bracket at position i-1
      const insertPos = contentStartGlobal + i - 1;
      // Add new text block before closing bracket
      const escapedInjection = injection
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n');
      const newBlock = `,{"type":"text","text":"\\n\\n${escapedInjection}"}`;
      return rawBody.slice(0, insertPos) + newBlock + rawBody.slice(insertPos);
    }
  }

  // Fallback: couldn't parse, return unchanged
  return rawBody;
}

export function appendToSystemPrompt(
  body: MessagesRequestBody,
  textToAppend: string
): void {
  if (typeof body.system === 'string') {
    body.system = body.system + textToAppend;
  } else if (Array.isArray(body.system)) {
    // Append as new text block WITHOUT cache_control
    // Anthropic allows max 4 cache blocks - Claude Code already uses 2+
    // Grov's injections are small (~2KB) so uncached is fine
    (body.system as Array<Record<string, unknown>>).push({
      type: 'text',
      text: textToAppend,
    });
  } else {
    // No system prompt yet, create as string
    body.system = textToAppend;
  }
}

export function injectIntoRawBody(rawBody: string, injectionText: string): { modified: string; success: boolean } {
  // Find the system array in the raw JSON
  // Pattern: "system": [....]
  const systemMatch = rawBody.match(/"system"\s*:\s*\[/);
  if (!systemMatch || systemMatch.index === undefined) {
    return { modified: rawBody, success: false };
  }

  // Find the matching closing bracket for the system array
  const startIndex = systemMatch.index + systemMatch[0].length;
  let bracketCount = 1;
  let endIndex = startIndex;

  for (let i = startIndex; i < rawBody.length && bracketCount > 0; i++) {
    const char = rawBody[i];
    if (char === '[') bracketCount++;
    else if (char === ']') bracketCount--;
    if (bracketCount === 0) {
      endIndex = i;
      break;
    }
  }

  if (bracketCount !== 0) {
    return { modified: rawBody, success: false };
  }

  // Escape the injection text for JSON
  const escapedText = JSON.stringify(injectionText).slice(1, -1); // Remove outer quotes

  // Create the new block (without cache_control - will be cache_creation)
  const newBlock = `,{"type":"text","text":"${escapedText}"}`;

  // Insert before the closing bracket
  const modified = rawBody.slice(0, endIndex) + newBlock + rawBody.slice(endIndex);

  return { modified, success: true };
}
