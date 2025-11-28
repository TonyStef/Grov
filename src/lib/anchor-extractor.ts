// Extract function/class anchors from source files for file-level reasoning

import { createHash } from 'crypto';
import { extname } from 'path';

export type AnchorType = 'function' | 'class' | 'method' | 'variable' | 'unknown';

export interface AnchorInfo {
  type: AnchorType;
  name: string;
  lineStart: number;
  lineEnd?: number;
}

// Language-specific regex patterns for extracting anchors
interface LanguagePatterns {
  function: RegExp;
  arrowFunction?: RegExp;
  class: RegExp;
  method: RegExp;
}

const TYPESCRIPT_PATTERNS: LanguagePatterns = {
  // export async function foo() or function foo()
  function: /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/,
  // export const foo = async () => or const foo = function()
  arrowFunction: /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?(?:\([^)]*\)\s*=>|\([^)]*\)\s*:\s*\w+\s*=>|function)/,
  // export class Foo or class Foo
  class: /^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/,
  // async foo() { or foo(): Promise<void> { or private foo() {
  method: /^\s+(?:public\s+|private\s+|protected\s+)?(?:static\s+)?(?:async\s+)?(\w+)\s*(?:<[^>]*>)?\s*\([^)]*\)/,
};

const PYTHON_PATTERNS: LanguagePatterns = {
  // def foo():
  function: /^def\s+(\w+)\s*\(/,
  // class Foo:
  class: /^class\s+(\w+)/,
  // def foo(self): (indented method)
  method: /^\s+def\s+(\w+)\s*\(/,
};

const GO_PATTERNS: LanguagePatterns = {
  // func foo() or func (r *Receiver) foo()
  function: /^func\s+(?:\([^)]+\)\s+)?(\w+)\s*\(/,
  // type Foo struct
  class: /^type\s+(\w+)\s+struct/,
  // Method receivers are handled by function pattern
  method: /^func\s+\([^)]+\)\s+(\w+)\s*\(/,
};

const RUST_PATTERNS: LanguagePatterns = {
  // fn foo() or pub fn foo()
  function: /^(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/,
  // struct Foo or pub struct Foo
  class: /^(?:pub\s+)?struct\s+(\w+)/,
  // fn foo(&self) inside impl block (indented)
  method: /^\s+(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/,
};

/**
 * Get language patterns based on file extension
 */
function getPatternsForFile(filePath: string): LanguagePatterns | null {
  const ext = extname(filePath).toLowerCase();

  switch (ext) {
    case '.ts':
    case '.tsx':
    case '.js':
    case '.jsx':
    case '.mjs':
    case '.cjs':
      return TYPESCRIPT_PATTERNS;
    case '.py':
      return PYTHON_PATTERNS;
    case '.go':
      return GO_PATTERNS;
    case '.rs':
      return RUST_PATTERNS;
    default:
      return null;
  }
}

// PERFORMANCE: Maximum anchors per file to prevent DoS
const MAX_ANCHORS_PER_FILE = 1000;

// PERFORMANCE: Maximum file size to process (1MB)
const MAX_FILE_SIZE = 1024 * 1024;

/**
 * Extract all anchors from a source file.
 * PERFORMANCE: Uses single-pass O(n) algorithm instead of O(n²).
 * SECURITY: Limits anchors to prevent DoS with pathological files.
 */
export function extractAnchors(filePath: string, content: string): AnchorInfo[] {
  // SECURITY: Skip files that are too large
  if (content.length > MAX_FILE_SIZE) {
    return [];
  }

  const patterns = getPatternsForFile(filePath);
  if (!patterns) {
    return [];
  }

  const lines = content.split('\n');
  const isPython = filePath.endsWith('.py');

  // PERFORMANCE: Single-pass extraction with tracking
  // We track open anchors that haven't found their closing brace yet
  interface OpenAnchor {
    type: AnchorType;
    name: string;
    lineStart: number;
    braceDepthAtStart: number;
    baseIndent?: number; // For Python
  }

  const anchors: AnchorInfo[] = [];
  const openAnchors: OpenAnchor[] = [];
  let currentBraceDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    // SECURITY: Stop if we've found too many anchors
    if (anchors.length >= MAX_ANCHORS_PER_FILE) {
      break;
    }

    const line = lines[i];
    const lineNumber = i + 1; // 1-indexed

    // Count braces in this line BEFORE pattern matching
    let lineOpenBraces = 0;
    let lineCloseBraces = 0;
    for (const char of line) {
      if (char === '{') lineOpenBraces++;
      else if (char === '}') lineCloseBraces++;
    }

    // Close any open anchors whose braces have returned to their start level
    // Do this BEFORE adding line's braces to handle same-line open/close
    if (!isPython) {
      // Process closing braces
      for (let b = 0; b < lineCloseBraces; b++) {
        currentBraceDepth--;
        // Check if any open anchor should be closed
        while (openAnchors.length > 0) {
          const top = openAnchors[openAnchors.length - 1];
          if (currentBraceDepth < top.braceDepthAtStart) {
            openAnchors.pop();
            anchors.push({
              type: top.type,
              name: top.name,
              lineStart: top.lineStart,
              lineEnd: lineNumber,
            });
          } else {
            break;
          }
        }
      }
    } else {
      // Python: Check indentation-based closing
      const currentIndent = line.match(/^(\s*)/)?.[1].length || 0;
      // Skip empty lines for indentation checking
      if (line.trim() && !line.trim().startsWith('#')) {
        while (openAnchors.length > 0) {
          const top = openAnchors[openAnchors.length - 1];
          if (top.baseIndent !== undefined && currentIndent <= top.baseIndent) {
            openAnchors.pop();
            anchors.push({
              type: top.type,
              name: top.name,
              lineStart: top.lineStart,
              lineEnd: lineNumber - 1, // End at previous line
            });
          } else {
            break;
          }
        }
      }
    }

    // Pattern matching - find new anchors
    let match: RegExpMatchArray | null = null;
    let anchorType: AnchorType | null = null;

    // Check for function
    match = line.match(patterns.function);
    if (match) {
      anchorType = 'function';
    }

    // Check for arrow function (TypeScript/JavaScript)
    if (!match && patterns.arrowFunction) {
      match = line.match(patterns.arrowFunction);
      if (match) {
        anchorType = 'function';
      }
    }

    // Check for class
    if (!match) {
      match = line.match(patterns.class);
      if (match) {
        anchorType = 'class';
      }
    }

    // Check for method (only if indented)
    if (!match && line.match(/^\s+/) && !line.match(/^\s*\/\//)) {
      match = line.match(patterns.method);
      if (match) {
        anchorType = 'method';
      }
    }

    // If we found a new anchor, add it to open anchors
    if (match && anchorType) {
      const baseIndent = isPython ? (line.match(/^(\s*)/)?.[1].length || 0) : undefined;
      openAnchors.push({
        type: anchorType,
        name: match[1],
        lineStart: lineNumber,
        braceDepthAtStart: currentBraceDepth + lineOpenBraces,
        baseIndent,
      });
    }

    // Update brace depth with opening braces
    if (!isPython) {
      currentBraceDepth += lineOpenBraces;
    }
  }

  // Close any remaining open anchors at end of file
  for (const open of openAnchors) {
    anchors.push({
      type: open.type,
      name: open.name,
      lineStart: open.lineStart,
      lineEnd: lines.length,
    });
  }

  return anchors;
}

/**
 * Find the end of a code block (function/class/method body)
 * Uses brace counting for C-like languages, indentation for Python
 */
function findBlockEnd(lines: string[], startIndex: number): number {
  const startLine = lines[startIndex];
  const isIndentBased = !startLine.includes('{');

  if (isIndentBased) {
    // Python-style: find end by indentation
    const baseIndent = startLine.match(/^(\s*)/)?.[1].length || 0;

    for (let i = startIndex + 1; i < lines.length; i++) {
      const line = lines[i];
      // Skip empty lines and comments
      if (!line.trim() || line.trim().startsWith('#')) continue;

      const currentIndent = line.match(/^(\s*)/)?.[1].length || 0;
      if (currentIndent <= baseIndent && line.trim()) {
        return i; // Previous line was the end
      }
    }
    return lines.length;
  }

  // Brace-counting for C-like languages
  let braceCount = 0;
  let foundOpenBrace = false;

  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i];

    for (const char of line) {
      if (char === '{') {
        braceCount++;
        foundOpenBrace = true;
      } else if (char === '}') {
        braceCount--;
      }
    }

    if (foundOpenBrace && braceCount === 0) {
      return i + 1; // 1-indexed
    }
  }

  return lines.length;
}

/**
 * Find which anchor contains a given line number
 */
export function findAnchorAtLine(anchors: AnchorInfo[], lineNumber: number): AnchorInfo | null {
  // Find the most specific (innermost) anchor that contains this line
  let bestMatch: AnchorInfo | null = null;

  for (const anchor of anchors) {
    const end = anchor.lineEnd || anchor.lineStart;

    if (lineNumber >= anchor.lineStart && lineNumber <= end) {
      // Prefer more specific matches (methods over classes)
      if (!bestMatch || anchor.lineStart > bestMatch.lineStart) {
        bestMatch = anchor;
      }
    }
  }

  return bestMatch;
}

/**
 * Compute a hash of a code region for change detection.
 * Uses SHA-256 (truncated) for security scanner compliance.
 */
export function computeCodeHash(content: string, lineStart: number, lineEnd: number): string {
  const lines = content.split('\n');
  const slice = lines.slice(lineStart - 1, lineEnd).join('\n');

  // Normalize whitespace for more stable hashes
  const normalized = slice.replace(/\s+/g, ' ').trim();

  // SECURITY: Use SHA-256 instead of MD5 (truncated for storage efficiency)
  return createHash('sha256').update(normalized).digest('hex').substring(0, 16);
}

/**
 * Estimate the line number where a string appears in content
 */
export function estimateLineNumber(searchString: string, content: string): number | null {
  if (!searchString || !content) return null;

  // Get first line of search string for matching
  const firstLine = searchString.split('\n')[0].trim();
  if (!firstLine) return null;

  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(firstLine)) {
      return i + 1; // 1-indexed
    }
  }

  return null;
}

/**
 * Get a human-readable description of an anchor
 */
export function describeAnchor(anchor: AnchorInfo): string {
  return `${anchor.type} "${anchor.name}" at line ${anchor.lineStart}${anchor.lineEnd ? `-${anchor.lineEnd}` : ''}`;
}
