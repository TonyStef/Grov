// CLI Sync Tracker - Deduplication + 6h cleanup
// File: ~/.grov/cli_synced.json

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const GROV_DIR = join(homedir(), '.grov');
const SYNCED_FILE = join(GROV_DIR, 'cli_synced.json');
const SIX_HOURS = 6 * 60 * 60 * 1000;

interface ChatData {
  captured: string[];  // usageUuids
  lastActivity: string; // ISO timestamp
}

interface SyncedData {
  chats: Record<string, ChatData>;  // agentId -> chat data
}

function ensureDir(): void {
  if (!existsSync(GROV_DIR)) {
    mkdirSync(GROV_DIR, { recursive: true });
  }
}

function readSyncedFile(): SyncedData {
  if (!existsSync(SYNCED_FILE)) {
    return { chats: {} };
  }
  try {
    return JSON.parse(readFileSync(SYNCED_FILE, 'utf-8'));
  } catch {
    return { chats: {} };
  }
}

function writeSyncedFile(data: SyncedData): void {
  ensureDir();
  writeFileSync(SYNCED_FILE, JSON.stringify(data, null, 2));
}

export function isAlreadyCaptured(agentId: string, usageUuid: string): boolean {
  const synced = readSyncedFile();
  return synced.chats[agentId]?.captured.includes(usageUuid) || false;
}

export function markAsCaptured(agentId: string, usageUuid: string): void {
  const synced = readSyncedFile();

  if (!synced.chats[agentId]) {
    synced.chats[agentId] = { captured: [], lastActivity: '' };
  }

  if (!synced.chats[agentId].captured.includes(usageUuid)) {
    synced.chats[agentId].captured.push(usageUuid);
  }
  synced.chats[agentId].lastActivity = new Date().toISOString();

  writeSyncedFile(synced);
}

export function cleanupOldChats(): void {
  const synced = readSyncedFile();
  const cutoff = Date.now() - SIX_HOURS;
  let changed = false;

  for (const [agentId, data] of Object.entries(synced.chats)) {
    if (new Date(data.lastActivity).getTime() < cutoff) {
      delete synced.chats[agentId];
      changed = true;
    }
  }

  if (changed) {
    writeSyncedFile(synced);
  }
}

// Get all captured usageUuids for an agent (for debugging)
export function getCapturedForAgent(agentId: string): string[] {
  const synced = readSyncedFile();
  return synced.chats[agentId]?.captured || [];
}
