// MCP In-Memory Cache
// Caches preview results for expand calls
// Keyed by project path with TTL

import type { Memory } from '@grov/shared';

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

interface CacheEntry {
  memories: Memory[];
  timestamp: number;
  previewIndices: number[];  // Which memories were shown in preview
}

interface PendingDecision {
  taskId: string;
  matchedMemory: Memory;
  timestamp: number;
}

// ─────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────

const TTL_MS = 10 * 60 * 1000;  // 10 minutes

// ─────────────────────────────────────────────────────────────
// Cache Storage
// ─────────────────────────────────────────────────────────────

// Keyed by project path
const previewCache = new Map<string, CacheEntry>();

// Pending decision state (for grov_decide_update flow)
let pendingDecision: PendingDecision | null = null;

// ─────────────────────────────────────────────────────────────
// Preview Cache Functions
// ─────────────────────────────────────────────────────────────

/**
 * Get current project path
 * Used as cache key
 */
export function getProjectPath(): string {
  return process.cwd();
}

/**
 * Store memories from preview call
 */
export function setPreviewCache(memories: Memory[], shownIndices: number[]): void {
  const projectPath = getProjectPath();

  previewCache.set(projectPath, {
    memories,
    timestamp: Date.now(),
    previewIndices: shownIndices,
  });
}

/**
 * Get cached memories for expand
 * Returns null if cache expired or missing
 */
export function getPreviewCache(): CacheEntry | null {
  const projectPath = getProjectPath();
  const entry = previewCache.get(projectPath);

  if (!entry) return null;

  // Check TTL
  if (Date.now() - entry.timestamp > TTL_MS) {
    previewCache.delete(projectPath);
    return null;
  }

  return entry;
}

/**
 * Get specific memory by 1-based index
 */
export function getMemoryByIndex(index: number): Memory | null {
  const cache = getPreviewCache();
  if (!cache) return null;

  // Convert 1-based to 0-based
  const idx = index - 1;
  if (idx < 0 || idx >= cache.memories.length) return null;

  return cache.memories[idx];
}

/**
 * Get multiple memories by indices
 */
export function getMemoriesByIndices(indices: number[]): Memory[] {
  const cache = getPreviewCache();
  if (!cache) return [];

  return indices
    .map((i) => cache.memories[i - 1])  // Convert 1-based to 0-based
    .filter((m): m is Memory => m !== undefined);
}

/**
 * Check if a memory was shown in preview
 */
export function wasShownInPreview(memoryId: string): boolean {
  const cache = getPreviewCache();
  if (!cache) return false;

  return cache.previewIndices.some((idx) => {
    const memory = cache.memories[idx - 1];
    return memory?.id === memoryId;
  });
}

/**
 * Clear preview cache (e.g., when project changes)
 */
export function clearPreviewCache(): void {
  const projectPath = getProjectPath();
  previewCache.delete(projectPath);
}

// ─────────────────────────────────────────────────────────────
// Pending Decision Functions
// ─────────────────────────────────────────────────────────────

/**
 * Store pending decision state
 * Called when grov_save finds a match and needs LLM decision
 */
export function setPendingDecision(taskId: string, matchedMemory: Memory): void {
  pendingDecision = {
    taskId,
    matchedMemory,
    timestamp: Date.now(),
  };
}

/**
 * Get pending decision state
 * Returns null if expired or not set
 */
export function getPendingDecision(): PendingDecision | null {
  if (!pendingDecision) return null;

  // Check TTL (5 minutes for decisions)
  if (Date.now() - pendingDecision.timestamp > 5 * 60 * 1000) {
    pendingDecision = null;
    return null;
  }

  return pendingDecision;
}

/**
 * Clear pending decision
 * Called after grov_decide_update completes
 */
export function clearPendingDecision(): void {
  pendingDecision = null;
}
