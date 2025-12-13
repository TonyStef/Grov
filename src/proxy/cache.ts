// Phase 0 verified
// Cache management for team memory injection
// Shared between server.ts and response-processor.ts to avoid circular dependencies

/**
 * Global team memory cache
 * - Calculated ONCE on first request, reused for ALL subsequent requests
 * - Invalidated only on: sync completion (in .then() callback), proxy restart
 * - Ensures system prompt prefix stays CONSTANT for Anthropic cache preservation
 */
export let globalTeamMemoryCache: { projectPath: string; content: string } | null = null;

/**
 * Invalidate the global team memory cache
 * Called after successful sync to cloud (in .then() callback)
 * This ensures cache is only invalidated AFTER data is in cloud
 */
export function invalidateTeamMemoryCache(): void {
  globalTeamMemoryCache = null;
  console.log('[CACHE] Team memory cache invalidated');
}

/**
 * Set the global team memory cache
 * @param projectPath - Project path for cache key
 * @param content - Formatted team memory content
 */
export function setTeamMemoryCache(projectPath: string, content: string): void {
  globalTeamMemoryCache = { projectPath, content };
  console.log(`[CACHE] Team memory cache set for project: ${projectPath} (${content.length} chars)`);
}

/**
 * Get the current cache content if it matches the project path
 * @param projectPath - Project path to check
 * @returns Cached content or null if not cached/different project
 */
export function getTeamMemoryCache(projectPath: string): string | null {
  if (globalTeamMemoryCache && globalTeamMemoryCache.projectPath === projectPath) {
    return globalTeamMemoryCache.content;
  }
  return null;
}

/**
 * Check if cache exists for a specific project
 */
export function hasCacheForProject(projectPath: string): boolean {
  return globalTeamMemoryCache?.projectPath === projectPath;
}

/**
 * Get current cache project path (for logging/debugging)
 */
export function getCacheProjectPath(): string | null {
  return globalTeamMemoryCache?.projectPath || null;
}
