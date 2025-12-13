// Debug and file logging utilities for Grov proxy

import * as fs from 'fs';
import * as path from 'path';

let debugMode = false;
let requestCounter = 0;

const PROXY_LOG_PATH = path.join(process.cwd(), 'grov-proxy.log');
const TASK_LOG_PATH = path.join(process.cwd(), 'grov-task.log');

export function setDebugMode(enabled: boolean): void {
  debugMode = enabled;
}

export function getNextRequestId(): number {
  return ++requestCounter;
}

export function taskLog(event: string, data: Record<string, unknown>): void {
  const timestamp = new Date().toISOString();
  const sessionId = data.sessionId ? String(data.sessionId).substring(0, 8) : '-';

  // Format: [timestamp] [session] EVENT: key=value key=value
  const kvPairs = Object.entries(data)
    .filter(([k]) => k !== 'sessionId')
    .map(([k, v]) => {
      const val = typeof v === 'string' ? v.substring(0, 100) : JSON.stringify(v);
      return `${k}=${val}`;
    })
    .join(' | ');

  const line = `[${timestamp}] [${sessionId}] ${event}: ${kvPairs}\n`;
  fs.appendFileSync(TASK_LOG_PATH, line);
}

interface ProxyLogEntry {
  timestamp: string;
  requestId: number;
  type: 'REQUEST' | 'RESPONSE' | 'INJECTION';
  sessionId?: string;
  data: Record<string, unknown>;
}

export function proxyLog(entry: Omit<ProxyLogEntry, 'timestamp'>): void {
  if (!debugMode) return;

  const logEntry: ProxyLogEntry = {
    timestamp: new Date().toISOString(),
    ...entry,
  };

  const line = JSON.stringify(logEntry) + '\n';
  fs.appendFileSync(PROXY_LOG_PATH, line);
}

export function logTokenUsage(
  requestId: number,
  usage: { cacheCreation: number; cacheRead: number; inputTokens: number; outputTokens: number },
  latencyMs: number
): void {
  const total = usage.cacheCreation + usage.cacheRead;
  const hitRatio = total > 0 ? ((usage.cacheRead / total) * 100).toFixed(0) : '0';
  console.log(
    `[${requestId}] ${hitRatio}% cache | in:${usage.inputTokens} out:${usage.outputTokens} | create:${usage.cacheCreation} read:${usage.cacheRead} | ${latencyMs}ms`
  );
}
