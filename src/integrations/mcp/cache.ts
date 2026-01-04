// MCP In-Memory Cache
// Caches preview results for expand calls
// Uses 8-char memory IDs for lookup (consistent with local proxy)
// Keyed by project path with TTL

import type { Memory } from '@grov/shared';

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

interface CacheEntry {
  memoriesById: Map<string, Memory>;  // 8-char ID -> Memory
  timestamp: number;
  cachedIds: string[];  // IDs shown in preview (for debugging)
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
// Project Path
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

// ─────────────────────────────────────────────────────────────
// Cache Operations
// ─────────────────────────────────────────────────────────────

/**
 * Store memories from preview call
 * Indexes by 8-char ID prefix for fast lookup
 */
export function setPreviewCache(memories: Memory[]): void {
  const projectPath = getProjectPath();

  const memoriesById = new Map<string, Memory>();
  const cachedIds: string[] = [];

  for (const m of memories) {
    const shortId = m.id.substring(0, 8);
    memoriesById.set(shortId, m);
    cachedIds.push(shortId);
  }

  previewCache.set(projectPath, {
    memoriesById,
    timestamp: Date.now(),
    cachedIds,
  });
}

/**
 * Get cached entry (internal use)
 * Returns null if cache expired or missing
 */
function getPreviewCache(): CacheEntry | null {
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
 * Get memory by 8-char ID
 * Handles both 8-char and full UUID (extracts first 8 chars)
 */
export function getMemoryById(id: string): Memory | null {
  const cache = getPreviewCache();
  if (!cache) return null;

  // Normalize to 8-char
  const shortId = id.substring(0, 8);
  return cache.memoriesById.get(shortId) || null;
}

/**
 * Get list of cached IDs (for error messages)
 */
export function getCachedIds(): string[] {
  const cache = getPreviewCache();
  return cache?.cachedIds || [];
}

/**
 * Clear preview cache (e.g., when project changes)
 */
export function clearPreviewCache(): void {
  const projectPath = getProjectPath();
  previewCache.delete(projectPath);
}
