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
    <div className="flex flex-wrap gap-2">
      <div className="relative flex-1 min-w-[160px]">
        <Search className="absolute left-2.5 top-1/2 h-3 w-3 -translate-y-1/2 text-text-quiet" />
        <input
          type="text"
          value={searchValue}
          onChange={handleSearchChange}
          placeholder="Search memories..."
          className="w-full rounded-md border border-border bg-bark pl-8 pr-3 py-1.5 text-xs text-text-bright placeholder:text-text-quiet focus:border-leaf/50 focus:outline-none transition-all"
        />
      </div>

      <select
        value={currentFilters.tags || ''}
        onChange={handleTagChange}
        className="rounded-md border border-border bg-bark px-2.5 py-1.5 text-xs text-text-calm focus:border-leaf/50 focus:outline-none transition-all"
      >
        <option value="">All tags</option>
        {availableTags.map((tag) => (
          <option key={tag} value={tag}>
            {tag}
          </option>
        ))}
      </select>

      <select
        value={currentFilters.status || ''}
        onChange={handleStatusChange}
        className="rounded-md border border-border bg-bark px-2.5 py-1.5 text-xs text-text-calm focus:border-leaf/50 focus:outline-none transition-all"
      >
        <option value="">All status</option>
        <option value="complete">Complete</option>
        <option value="question">Question</option>
        <option value="partial">Partial</option>
        <option value="abandoned">Abandoned</option>
      </select>

      {hasActiveFilters && (
        <button
          onClick={clearFilters}
          className="flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs text-text-quiet hover:bg-bark hover:text-text-calm transition-all"
        >
          <X className="h-3 w-3" />
          Clear
        </button>
      )}
    </div>
  );
}
