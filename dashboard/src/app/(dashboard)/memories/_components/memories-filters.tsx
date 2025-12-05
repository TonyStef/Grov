'use client';

import { useState, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Search, X } from 'lucide-react';
import { useDebouncedCallback } from 'use-debounce';

interface MemoriesFiltersProps {
  availableTags: string[];
  currentFilters: {
    search?: string;
    tags?: string;
    status?: string;
    user?: string;
  };
}

export function MemoriesFilters({
  availableTags,
  currentFilters,
}: MemoriesFiltersProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [searchValue, setSearchValue] = useState(currentFilters.search || '');

  // Update URL with new filters
  const updateFilters = useCallback(
    (updates: Record<string, string | undefined>) => {
      const params = new URLSearchParams(searchParams.toString());

      Object.entries(updates).forEach(([key, value]) => {
        if (value) {
          params.set(key, value);
        } else {
          params.delete(key);
        }
      });

      // Remove cursor when filters change
      params.delete('cursor');

      router.push(`/memories?${params.toString()}`);
    },
    [router, searchParams]
  );

  // Debounced search
  const debouncedSearch = useDebouncedCallback((value: string) => {
    updateFilters({ search: value || undefined });
  }, 300);

  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setSearchValue(value);
    debouncedSearch(value);
  };

  const handleTagChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const value = e.target.value;
    updateFilters({ tags: value || undefined });
  };

  const handleStatusChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const value = e.target.value;
    updateFilters({ status: value || undefined });
  };

  const clearFilters = () => {
    setSearchValue('');
    router.push('/memories');
  };

  const hasActiveFilters = !!(
    currentFilters.search ||
    currentFilters.tags ||
    currentFilters.status
  );

  return (
    <div className="flex flex-wrap gap-4">
      {/* Search */}
      <div className="relative flex-1 min-w-[200px]">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
        <input
          type="text"
          value={searchValue}
          onChange={handleSearchChange}
          placeholder="Search memories..."
          className="w-full rounded-md border border-border bg-bg-2 pl-10 pr-4 py-2 text-sm placeholder:text-text-muted focus:border-accent-400 focus:outline-none focus:ring-1 focus:ring-accent-400"
        />
      </div>

      {/* Tags filter */}
      <select
        value={currentFilters.tags || ''}
        onChange={handleTagChange}
        className="rounded-md border border-border bg-bg-2 px-4 py-2 text-sm text-text-secondary focus:border-accent-400 focus:outline-none focus:ring-1 focus:ring-accent-400"
      >
        <option value="">All tags</option>
        {availableTags.map((tag) => (
          <option key={tag} value={tag}>
            {tag}
          </option>
        ))}
      </select>

      {/* Status filter */}
      <select
        value={currentFilters.status || ''}
        onChange={handleStatusChange}
        className="rounded-md border border-border bg-bg-2 px-4 py-2 text-sm text-text-secondary focus:border-accent-400 focus:outline-none focus:ring-1 focus:ring-accent-400"
      >
        <option value="">All status</option>
        <option value="complete">Complete</option>
        <option value="question">Question</option>
        <option value="partial">Partial</option>
        <option value="abandoned">Abandoned</option>
      </select>

      {/* Clear filters */}
      {hasActiveFilters && (
        <button
          onClick={clearFilters}
          className="flex items-center gap-1.5 rounded-md px-3 py-2 text-sm text-text-muted hover:bg-bg-2 hover:text-text-secondary transition-colors"
        >
          <X className="h-4 w-4" />
          Clear
        </button>
      )}
    </div>
  );
}
