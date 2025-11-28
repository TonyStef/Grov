import { describe, it, expect } from 'vitest';
import { truncate, capitalize, dedupeBy, formatRelativeTime, isNonEmptyString } from '../src/lib/utils.js';

describe('truncate', () => {
  it('should return the original string if shorter than maxLength', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });

  it('should truncate long strings and add ellipsis', () => {
    expect(truncate('hello world', 8)).toBe('hello...');
  });

  it('should handle exact length strings', () => {
    expect(truncate('hello', 5)).toBe('hello');
  });

  it('should handle empty strings', () => {
    expect(truncate('', 10)).toBe('');
  });

  it('should handle very short maxLength', () => {
    expect(truncate('hello', 3)).toBe('...');
  });
});

describe('capitalize', () => {
  it('should capitalize the first letter', () => {
    expect(capitalize('hello')).toBe('Hello');
  });

  it('should handle already capitalized strings', () => {
    expect(capitalize('Hello')).toBe('Hello');
  });

  it('should handle single character strings', () => {
    expect(capitalize('h')).toBe('H');
  });

  it('should handle empty strings', () => {
    expect(capitalize('')).toBe('');
  });

  it('should not change the rest of the string', () => {
    expect(capitalize('hELLO')).toBe('HELLO');
  });
});

describe('dedupeBy', () => {
  it('should remove duplicates by key function', () => {
    const items = [
      { id: '1', name: 'a' },
      { id: '2', name: 'b' },
      { id: '1', name: 'c' }, // duplicate id
    ];
    const result = dedupeBy(items, item => item.id);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('a');
    expect(result[1].name).toBe('b');
  });

  it('should handle empty arrays', () => {
    const result = dedupeBy([], (item: { id: string }) => item.id);
    expect(result).toHaveLength(0);
  });

  it('should handle arrays with no duplicates', () => {
    const items = [
      { id: '1', name: 'a' },
      { id: '2', name: 'b' },
    ];
    const result = dedupeBy(items, item => item.id);
    expect(result).toHaveLength(2);
  });
});

describe('formatRelativeTime', () => {
  it('should format recent times as "just now"', () => {
    const now = new Date();
    expect(formatRelativeTime(now)).toBe('just now');
  });

  it('should format minutes ago', () => {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    expect(formatRelativeTime(fiveMinutesAgo)).toBe('5 minutes ago');
  });

  it('should format hours ago', () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    expect(formatRelativeTime(twoHoursAgo)).toBe('2 hours ago');
  });

  it('should format days ago', () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    expect(formatRelativeTime(threeDaysAgo)).toBe('3 days ago');
  });

  it('should handle singular forms', () => {
    const oneMinuteAgo = new Date(Date.now() - 1 * 60 * 1000);
    expect(formatRelativeTime(oneMinuteAgo)).toBe('1 minute ago');

    const oneHourAgo = new Date(Date.now() - 1 * 60 * 60 * 1000);
    expect(formatRelativeTime(oneHourAgo)).toBe('1 hour ago');

    const oneDayAgo = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000);
    expect(formatRelativeTime(oneDayAgo)).toBe('1 day ago');
  });

  it('should handle string dates', () => {
    const isoString = new Date(Date.now() - 60 * 1000).toISOString();
    expect(formatRelativeTime(isoString)).toBe('1 minute ago');
  });
});

describe('isNonEmptyString', () => {
  it('should return true for non-empty strings', () => {
    expect(isNonEmptyString('hello')).toBe(true);
  });

  it('should return false for empty strings', () => {
    expect(isNonEmptyString('')).toBe(false);
  });

  it('should return false for non-strings', () => {
    expect(isNonEmptyString(null)).toBe(false);
    expect(isNonEmptyString(undefined)).toBe(false);
    expect(isNonEmptyString(123)).toBe(false);
    expect(isNonEmptyString({})).toBe(false);
    expect(isNonEmptyString([])).toBe(false);
  });
});
