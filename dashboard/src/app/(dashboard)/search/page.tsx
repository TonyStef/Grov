import type { Metadata } from 'next';
import { Search as SearchIcon } from 'lucide-react';

export const metadata: Metadata = {
  title: 'Search',
};

export default function SearchPage() {
  return (
    <div className="animate-fade-in space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Search</h1>
        <p className="mt-1 text-text-secondary">
          Find reasoning across all your team&apos;s memories
        </p>
      </div>

      {/* Search Input */}
      <div className="relative">
        <SearchIcon className="absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-text-muted" />
        <input
          type="text"
          placeholder="Search for anything..."
          className="w-full rounded-lg border border-border bg-bg-2 py-4 pl-12 pr-4 text-lg placeholder:text-text-muted focus:border-accent-400 focus:outline-none focus:ring-1 focus:ring-accent-400"
          autoFocus
        />
      </div>

      {/* Search Tips */}
      <div className="rounded-lg border border-border bg-bg-1 p-6">
        <h2 className="mb-4 font-medium">Search Tips</h2>
        <ul className="space-y-2 text-sm text-text-secondary">
          <li>
            <code className="rounded bg-bg-2 px-1.5 py-0.5 font-mono text-accent-400">
              tag:auth
            </code>{' '}
            - Search by tag
          </li>
          <li>
            <code className="rounded bg-bg-2 px-1.5 py-0.5 font-mono text-accent-400">
              file:src/auth.ts
            </code>{' '}
            - Search by file path
          </li>
          <li>
            <code className="rounded bg-bg-2 px-1.5 py-0.5 font-mono text-accent-400">
              user:tony
            </code>{' '}
            - Search by team member
          </li>
          <li>
            <code className="rounded bg-bg-2 px-1.5 py-0.5 font-mono text-accent-400">
              from:2025-01-01
            </code>{' '}
            - Search from date
          </li>
        </ul>
      </div>
    </div>
  );
}
