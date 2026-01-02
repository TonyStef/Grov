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

// ─────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────

const TTL_MS = 10 * 60 * 1000;  // 10 minutes

// ─────────────────────────────────────────────────────────────
// Cache Storage
// ─────────────────────────────────────────────────────────────

// Keyed by project path
const previewCache = new Map<string, CacheEntry>();

// ─────────────────────────────────────────────────────────────
// Preview Cache Functions
// ─────────────────────────────────────────────────────────────

/**
 * Get current project path
 * Used as cache key and for API filtering
 *
 * Cursor sets WORKSPACE_FOLDER_PATHS env var with the open workspace path.
 * We extract just the folder name to match how proxy stores project_path.
 */
export function getProjectPath(): string {
  const workspacePaths = process.env.WORKSPACE_FOLDER_PATHS;

  if (workspacePaths) {
    // Can be multiple paths separated by some delimiter, take first one
    const firstPath = workspacePaths.split(':')[0] || workspacePaths;
    // Extract just the folder name (e.g., "/home/marian/Grov" -> "Grov")
    const folderName = firstPath.split('/').filter(Boolean).pop();
    if (folderName) {
      return folderName;
    }
  }

  // Fallback to cwd folder name
  const cwdParts = process.cwd().split('/').filter(Boolean);
  return cwdParts.pop() || process.cwd();
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
 * Clear preview cache (e.g., when project changes)
 */
export function clearPreviewCache(): void {
  const projectPath = getProjectPath();
  previewCache.delete(projectPath);
}
