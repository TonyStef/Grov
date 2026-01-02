// Track which Cursor messages have been synced to cloud
// File: ~/.grov/cursor_synced.json

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';

const GROV_DIR = join(homedir(), '.grov');
const SYNCED_FILE = join(GROV_DIR, 'cursor_synced.json');
const PLAN_STATE_FILE = join(GROV_DIR, 'cursor_plan_state.json');

// Format: "composerId:usageUuid"
type SyncedId = string;

interface PlanState {
  composerId: string;
  usageUuids: string[];
  lastActivity: number;  // timestamp
}

function ensureDir(): void {
  if (!existsSync(GROV_DIR)) {
    mkdirSync(GROV_DIR, { recursive: true });
  }
}

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as T;
  } catch {
    return fallback;
  }
}

function writeJson(path: string, data: unknown): void {
  ensureDir();
  writeFileSync(path, JSON.stringify(data, null, 2));
}

// ─────────────────────────────────────────────────────────────
// Synced Messages
// ─────────────────────────────────────────────────────────────

export function getSyncedIds(): Set<SyncedId> {
  const arr = readJson<SyncedId[]>(SYNCED_FILE, []);
  return new Set(arr);
}

export function isSynced(composerId: string, usageUuid: string): boolean {
  const synced = getSyncedIds();
  return synced.has(`${composerId}:${usageUuid}`);
}

export function markSynced(composerId: string, usageUuid: string): void {
  const synced = getSyncedIds();
  synced.add(`${composerId}:${usageUuid}`);
  writeJson(SYNCED_FILE, Array.from(synced));
}

// ─────────────────────────────────────────────────────────────
// Plan Mode State (accumulation + timeout)
// ─────────────────────────────────────────────────────────────

export function getPlanState(): PlanState | null {
  return readJson<PlanState | null>(PLAN_STATE_FILE, null);
}

export function setPlanState(composerId: string, usageUuids: string[]): void {
  const state: PlanState = {
    composerId,
    usageUuids,
    lastActivity: Date.now(),
  };
  writeJson(PLAN_STATE_FILE, state);
}

export function addToPlanState(composerId: string, usageUuid: string): void {
  const current = getPlanState();

  if (current && current.composerId === composerId) {
    // Same conversation, add prompt
    if (!current.usageUuids.includes(usageUuid)) {
      current.usageUuids.push(usageUuid);
    }
    current.lastActivity = Date.now();
    writeJson(PLAN_STATE_FILE, current);
  } else {
    // New conversation, start fresh
    setPlanState(composerId, [usageUuid]);
  }
}

export function clearPlanState(): void {
  if (existsSync(PLAN_STATE_FILE)) {
    writeFileSync(PLAN_STATE_FILE, 'null');
  }
}

export function isPlanTimedOut(timeoutMs: number = 5 * 60 * 1000): boolean {
  const state = getPlanState();
  if (!state) return false;
  return Date.now() - state.lastActivity > timeoutMs;
}

// ─────────────────────────────────────────────────────────────
// Cleanup (optional, for large synced files)
// ─────────────────────────────────────────────────────────────

export function pruneSyncedOlderThan(days: number = 30): void {
  // For now, simple approach: if file > 100KB, keep only last 1000 entries
  if (!existsSync(SYNCED_FILE)) return;

  try {
    const stats = require('fs').statSync(SYNCED_FILE);
    if (stats.size > 100 * 1024) {
      const synced = Array.from(getSyncedIds());
      const pruned = synced.slice(-1000);
      writeJson(SYNCED_FILE, pruned);
    }
  } catch {
    // Ignore
  }
}
