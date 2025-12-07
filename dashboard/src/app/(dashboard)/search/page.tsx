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
    <div className="animate-fade-in space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Search</h1>
        <p className="mt-1 text-text-secondary">
          Find reasoning across all your team&apos;s memories
        </p>
      </div>

      <SearchClient defaultTeamId={defaultTeamId} />
    </div>
  );
}
