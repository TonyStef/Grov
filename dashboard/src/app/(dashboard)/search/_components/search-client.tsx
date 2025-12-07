'use client';

import { useState, useTransition, useCallback } from 'react';
import { Search as SearchIcon, Loader2 } from 'lucide-react';
import { searchMemories } from '../actions';
import type { MemoryWithProfile } from '@/lib/queries/memories';
import Link from 'next/link';

interface SearchClientProps {
  defaultTeamId: string | null;
}

export function SearchClient({ defaultTeamId }: SearchClientProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<MemoryWithProfile[]>([]);
  const [hasSearched, setHasSearched] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const handleSearch = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    if (!defaultTeamId || !query.trim()) return;

    setError(null);
    setHasSearched(true);

    startTransition(async () => {
      const result = await searchMemories(defaultTeamId, query);
      if (result.error) {
        setError(result.error);
        setResults([]);
      } else {
        setResults(result.memories);
        setHasMore(result.hasMore);
        setCursor(result.cursor);
      }
    });
  }, [defaultTeamId, query]);

  const loadMore = useCallback(() => {
    if (!defaultTeamId || !cursor) return;

    startTransition(async () => {
      const result = await searchMemories(defaultTeamId, query, cursor);
      if (!result.error) {
        setResults(prev => [...prev, ...result.memories]);
        setHasMore(result.hasMore);
        setCursor(result.cursor);
      }
    });
  }, [defaultTeamId, query, cursor]);

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  };

  if (!defaultTeamId) {
    return (
      <div className="rounded-lg border border-border bg-bg-1 p-6 text-center">
        <p className="text-text-muted">Join or create a team to search memories.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Search Input */}
      <form onSubmit={handleSearch}>
        <div className="relative">
          <SearchIcon className="absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-text-muted" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search for anything..."
            className="w-full rounded-lg border border-border bg-bg-2 py-4 pl-12 pr-4 text-lg placeholder:text-text-muted focus:border-accent-400 focus:outline-none focus:ring-1 focus:ring-accent-400"
            autoFocus
          />
          {isPending && (
            <Loader2 className="absolute right-4 top-1/2 h-5 w-5 -translate-y-1/2 animate-spin text-text-muted" />
          )}
        </div>
      </form>

      {/* Error */}
      {error && (
        <div className="rounded-md bg-error/10 px-4 py-2 text-sm text-error">
          {error}
        </div>
      )}

      {/* Results */}
      {hasSearched && !isPending && results.length === 0 && !error && (
        <div className="rounded-lg border border-border bg-bg-1 p-8 text-center">
          <p className="text-text-muted">No memories found for &quot;{query}&quot;</p>
        </div>
      )}

      {results.length > 0 && (
        <div className="space-y-3">
          <p className="text-sm text-text-muted">
            {results.length} result{results.length !== 1 ? 's' : ''} found
          </p>

          {results.map((memory) => (
            <Link
              key={memory.id}
              href={`/memories/${memory.id}`}
              className="block rounded-lg border border-border bg-bg-1 p-4 transition-colors hover:border-border-hover hover:bg-bg-2"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <h3 className="font-medium text-text-primary truncate">
                    {memory.original_query || 'Untitled memory'}
                  </h3>
                  {memory.goal && (
                    <p className="mt-1 text-sm text-text-secondary line-clamp-2">
                      {memory.goal}
                    </p>
                  )}
                  <div className="mt-2 flex items-center gap-3 text-xs text-text-muted">
                    <span>{formatDate(memory.created_at)}</span>
                    {memory.profile?.full_name && (
                      <span>by {memory.profile.full_name}</span>
                    )}
                    {memory.tags && memory.tags.length > 0 && (
                      <div className="flex gap-1">
                        {memory.tags.slice(0, 3).map((tag) => (
                          <span
                            key={tag}
                            className="rounded bg-bg-3 px-1.5 py-0.5"
                          >
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${
                    memory.status === 'complete'
                      ? 'bg-success/10 text-success'
                      : memory.status === 'partial'
                      ? 'bg-warning/10 text-warning'
                      : 'bg-bg-3 text-text-muted'
                  }`}
                >
                  {memory.status}
                </span>
              </div>
            </Link>
          ))}

          {/* Load More */}
          {hasMore && (
            <button
              onClick={loadMore}
              disabled={isPending}
              className="w-full rounded-md border border-border py-2 text-sm text-text-secondary transition-colors hover:bg-bg-2 disabled:opacity-50"
            >
              {isPending ? 'Loading...' : 'Load more'}
            </button>
          )}
        </div>
      )}

      {/* Search Tips - show only when no search has been made */}
      {!hasSearched && (
        <div className="rounded-lg border border-border bg-bg-1 p-6">
          <h2 className="mb-4 font-medium">Search Tips</h2>
          <ul className="space-y-2 text-sm text-text-secondary">
            <li>
              Search by keywords in the original query or goal
            </li>
            <li>
              Results are sorted by most recent first
            </li>
            <li>
              Click on a result to see full details
            </li>
          </ul>
        </div>
      )}
    </div>
  );
}
