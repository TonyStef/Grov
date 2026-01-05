// Track which Antigravity sessions have been synced to cloud
// File: ~/.grov/antigravity_synced.json

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const GROV_DIR = join(homedir(), '.grov');
const SYNCED_FILE = join(GROV_DIR, 'antigravity_synced.json');

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

interface SyncedEntry {
  sessionId: string;
  syncedAt: string;
  planHash?: string; // To detect plan updates
}

interface SyncedState {
  entries: SyncedEntry[];
}

// ─────────────────────────────────────────────────────────────
// File Operations
// ─────────────────────────────────────────────────────────────

function ensureDir(): void {
  if (!existsSync(GROV_DIR)) {
    mkdirSync(GROV_DIR, { recursive: true });
  }
}

function readState(): SyncedState {
  if (!existsSync(SYNCED_FILE)) {
    return { entries: [] };
  }
  try {
    const content = readFileSync(SYNCED_FILE, 'utf-8');
    return JSON.parse(content) as SyncedState;
  } catch {
    return { entries: [] };
  }
}

function writeState(state: SyncedState): void {
  ensureDir();
  writeFileSync(SYNCED_FILE, JSON.stringify(state, null, 2));
}

// ─────────────────────────────────────────────────────────────
// Hash Helper
// ─────────────────────────────────────────────────────────────

/**
 * Simple hash for detecting plan content changes
 */
export function hashContent(content: string): string {
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return hash.toString(16);
}

// ─────────────────────────────────────────────────────────────
// Sync Tracking
// ─────────────────────────────────────────────────────────────

/**
 * Check if a session has been synced
 */
export function isSynced(sessionId: string): boolean {
  const state = readState();
  return state.entries.some(e => e.sessionId === sessionId);
}

/**
 * Check if a session needs update (plan content changed)
 */
export function needsUpdate(sessionId: string, planContent: string): boolean {
  const state = readState();
  const entry = state.entries.find(e => e.sessionId === sessionId);
  
  if (!entry) return true; // Not synced yet
  
  const currentHash = hashContent(planContent);
  return entry.planHash !== currentHash;
}

/**
 * Mark a session as synced
 */
export function markSynced(sessionId: string, planContent?: string): void {
  const state = readState();
  const existingIdx = state.entries.findIndex(e => e.sessionId === sessionId);
  
  const entry: SyncedEntry = {
    sessionId,
    syncedAt: new Date().toISOString(),
    planHash: planContent ? hashContent(planContent) : undefined,
  };
  
  if (existingIdx >= 0) {
    state.entries[existingIdx] = entry;
  } else {
    state.entries.push(entry);
  }
  
  writeState(state);
}

/**
 * Get all synced session IDs
 */
export function getSyncedSessionIds(): string[] {
  const state = readState();
  return state.entries.map(e => e.sessionId);
}

/**
 * Get sessions that haven't been synced yet
 */
export function getUnsynced(allSessionIds: string[]): string[] {
  const synced = new Set(getSyncedSessionIds());
  return allSessionIds.filter(id => !synced.has(id));
}

/**
 * Remove old entries to keep file size manageable
 * Keeps most recent 500 entries
 */
export function pruneOldEntries(keepCount: number = 500): void {
  const state = readState();
  
  if (state.entries.length <= keepCount) return;
  
  // Sort by syncedAt descending and keep most recent
  state.entries.sort((a, b) => {
    return new Date(b.syncedAt).getTime() - new Date(a.syncedAt).getTime();
  });
  
  state.entries = state.entries.slice(0, keepCount);
  writeState(state);
}

