'use server';

import { getMemoriesList, type MemoryWithProfile } from '@/lib/queries/memories';

interface SearchResult {
  memories: MemoryWithProfile[];
  hasMore: boolean;
  cursor: string | null;
  error?: string;
}

export async function searchMemories(
  teamId: string,
  query: string,
  cursor?: string
): Promise<SearchResult> {
  if (!teamId) {
    return { memories: [], hasMore: false, cursor: null, error: 'No team selected' };
  }

  if (!query.trim()) {
    return { memories: [], hasMore: false, cursor: null };
  }

  try {
    const result = await getMemoriesList(
      teamId,
      { search: query.trim() },
      20,
      cursor
    );

    return {
      memories: result.memories,
      hasMore: result.has_more,
      cursor: result.cursor,
    };
  } catch (err) {
    console.error('Search error:', err);
    return { memories: [], hasMore: false, cursor: null, error: 'Search failed' };
  }
}
