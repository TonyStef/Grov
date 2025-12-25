/**
 * Shared utility functions for Grov CLI.
 */

/**
 * Truncate a string to a maximum length, adding ellipsis if truncated.
 */
export function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return str.substring(0, maxLength - 3) + '...';
}

/**
 * Smart truncate: cleans markdown noise, prefers sentence/punctuation boundaries.
 * Used for reasoning content that may contain markdown tables, bullets, etc.
 */
export function smartTruncate(text: string, maxLen: number = 120): string {
  // 1. Clean markdown noise
  let clean = text
    .replace(/\|[^|]+\|/g, '')           // markdown table cells
    .replace(/^[-*]\s*/gm, '')           // bullet points
    .replace(/#{1,6}\s*/g, '')           // headers
    .replace(/\n+/g, ' ')                // newlines to space
    .replace(/\s+/g, ' ')                // multiple spaces to one
    .trim();

  // 2. If short enough, return as-is
  if (clean.length <= maxLen) return clean;

  // 3. Try to keep complete sentences
  const sentences = clean.match(/[^.!?]+[.!?]+/g) || [];
  let result = '';
  for (const sentence of sentences) {
    if ((result + sentence).length <= maxLen) {
      result += sentence;
    } else {
      break;
    }
  }

  // 4. If we got at least one meaningful sentence, return it
  if (result.length > 20) return result.trim();

  // 5. Fallback: find punctuation boundary
  const truncated = clean.slice(0, maxLen);
  const breakPoints = [
    truncated.lastIndexOf('. '),
    truncated.lastIndexOf(', '),
    truncated.lastIndexOf('; '),
    truncated.lastIndexOf(': '),
    truncated.lastIndexOf(' - '),
    truncated.lastIndexOf(' '),
  ].filter(p => p > maxLen * 0.6);

  const cutPoint = breakPoints.length > 0
    ? Math.max(...breakPoints)
    : truncated.lastIndexOf(' ');

  return truncated.slice(0, cutPoint > 0 ? cutPoint : maxLen).trim() + '...';
}

/**
 * Capitalize the first letter of a string.
 */
export function capitalize(str: string): string {
  if (!str) return str;
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Deduplicate items in an array by a key function.
 */
export function dedupeBy<T>(items: T[], keyFn: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter(item => {
    const key = keyFn(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Format a date as a relative time string (e.g., "2 hours ago").
 */
export function formatRelativeTime(date: Date | string): string {
  const now = new Date();
  const then = typeof date === 'string' ? new Date(date) : date;
  const diffMs = now.getTime() - then.getTime();
  const diffSeconds = Math.floor(diffMs / 1000);
  const diffMinutes = Math.floor(diffSeconds / 60);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffDays > 0) {
    return diffDays === 1 ? '1 day ago' : `${diffDays} days ago`;
  }
  if (diffHours > 0) {
    return diffHours === 1 ? '1 hour ago' : `${diffHours} hours ago`;
  }
  if (diffMinutes > 0) {
    return diffMinutes === 1 ? '1 minute ago' : `${diffMinutes} minutes ago`;
  }
  return 'just now';
}

/**
 * Safely extract a substring from a string.
 */
export function safeSubstring(str: string, start: number, end?: number): string {
  if (!str) return '';
  const safeStart = Math.max(0, Math.min(start, str.length));
  const safeEnd = end !== undefined ? Math.min(end, str.length) : str.length;
  return str.substring(safeStart, safeEnd);
}

/**
 * Check if a value is a non-empty string.
 */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Sleep for a specified number of milliseconds.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
