import type { Metadata } from 'next';
import { SearchClient } from './_components/search-client';
import { getUserTeams } from '@/lib/queries/teams';

export const metadata: Metadata = {
  title: 'Search',
};

export default async function SearchPage() {
  const teams = await getUserTeams();
  const defaultTeamId = teams[0]?.id || null;

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
