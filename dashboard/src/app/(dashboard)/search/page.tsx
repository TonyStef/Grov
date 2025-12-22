import type { Metadata } from 'next';
import { SearchClient } from './_components/search-client';
import { getCurrentTeamId } from '@/lib/queries/current-team';

export const metadata: Metadata = {
  title: 'Search',
};

export default async function SearchPage() {
  const defaultTeamId = await getCurrentTeamId();

  return (
    <div className="animate-grow-in space-y-4 p-6">
      <header>
        <h1 className="text-xl font-semibold">Search</h1>
        <p className="text-sm text-text-calm">
          Find reasoning across all your team&apos;s memories
        </p>
      </header>

      <SearchClient defaultTeamId={defaultTeamId} />
    </div>
  );
}
