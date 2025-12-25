/**
 * Debug logging module for Grov CLI.
 *
 * Enable debug output by setting the DEBUG environment variable:
 *   DEBUG=grov:* grov status        # All grov logs
 *   DEBUG=grov:capture grov capture # Only capture logs
 *   DEBUG=grov:store,grov:llm       # Multiple namespaces
 *
 * Available namespaces:
 *   grov:capture   - Session capture operations
 *   grov:inject    - Context injection operations
 *   grov:store     - Database operations
 *   grov:parser    - JSONL parsing operations
 *   grov:hooks     - Hook registration operations
 *   grov:llm       - LLM extraction operations
 */

import createDebug from 'debug';

// Main debug namespaces
export const debugCapture = createDebug('grov:capture');
export const debugInject = createDebug('grov:inject');
export const debugStore = createDebug('grov:store');
export const debugParser = createDebug('grov:parser');
export const debugHooks = createDebug('grov:hooks');
export const debugLLM = createDebug('grov:llm');

// Utility for checking if any grov debug is enabled
export function isDebugEnabled(): boolean {
  return createDebug.enabled('grov:*') ||
         createDebug.enabled('grov:capture') ||
         createDebug.enabled('grov:inject') ||
         createDebug.enabled('grov:store') ||
         createDebug.enabled('grov:parser') ||
         createDebug.enabled('grov:hooks') ||
         createDebug.enabled('grov:llm');
}
