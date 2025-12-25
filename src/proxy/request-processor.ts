// Request processor - helpers for extracting info from messages

/**
 * Extract file paths from messages (user messages only, clean text)
 */
export function extractFilesFromMessages(
  messages: Array<{ role: string; content: unknown }>
): string[] {
  const files: string[] = [];
  const filePattern = /(?:^|\s|["'`])([\/\w.-]+\.[a-zA-Z]{1,10})(?:["'`]|\s|$|[:)\]?!,;])/g;

  for (const msg of messages) {
    if (msg.role !== 'user') continue;

    let textContent = '';

    if (typeof msg.content === 'string') {
      textContent = msg.content;
    }

    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block && typeof block === 'object' && 'type' in block && block.type === 'text' && 'text' in block && typeof block.text === 'string') {
          textContent += block.text + '\n';
        }
      }
    }

    const cleanContent = textContent
      .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
      .trim();

    if (cleanContent) {
      let match;
      while ((match = filePattern.exec(cleanContent)) !== null) {
        const path = match[1];
        if (!path.includes('http') && !path.startsWith('.') && path.length > 3) {
          files.push(path);
        }
      }
    }
  }

  return [...new Set(files)];
}

/**
 * Extract the last user prompt from messages for semantic search
 */
export function extractLastUserPrompt(
  messages: Array<{ role: string; content: unknown }>
): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'user') continue;

    let textContent = '';

    if (typeof msg.content === 'string') {
      textContent = msg.content;
    }

    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block && typeof block === 'object' && 'type' in block && block.type === 'text' && 'text' in block && typeof block.text === 'string') {
          textContent += block.text + '\n';
        }
      }
    }

    const cleanContent = textContent
      .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
      .replace(/\\n["']?\s*<\/system-reminder>/g, '')
      .replace(/<\/system-reminder>/g, '')
      .replace(/^This session is being continued from a previous conversation[\s\S]*?Summary:/gi, '')
      .replace(/^[\s\n"'\\]+/, '')
      .trim();

    if (cleanContent && cleanContent.length > 5) {
      return cleanContent;
    }
  }

  return undefined;
}
