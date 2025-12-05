import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Memories',
};

export default function MemoriesPage() {
  return (
    <div className="animate-fade-in space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Memories</h1>
          <p className="mt-1 text-text-secondary">
            Browse captured reasoning from your team&apos;s sessions
          </p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex gap-4">
        <input
          type="text"
          placeholder="Search memories..."
          className="flex-1 rounded-md border border-border bg-bg-2 px-4 py-2 text-sm placeholder:text-text-muted focus:border-accent-400 focus:outline-none focus:ring-1 focus:ring-accent-400"
        />
        <select className="rounded-md border border-border bg-bg-2 px-4 py-2 text-sm text-text-secondary">
          <option>All tags</option>
        </select>
        <select className="rounded-md border border-border bg-bg-2 px-4 py-2 text-sm text-text-secondary">
          <option>All users</option>
        </select>
      </div>

      {/* Empty State */}
      <div className="flex h-64 flex-col items-center justify-center rounded-lg border border-dashed border-border">
        <div className="text-center">
          <p className="text-lg font-medium">No memories yet</p>
          <p className="mt-1 text-sm text-text-muted">
            Memories will appear here once you start syncing from the CLI
          </p>
        </div>
      </div>
    </div>
  );
}
