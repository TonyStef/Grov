import type { Metadata } from 'next';
import { getUserWithPreferences, getTeamWithSettings, isTeamAdmin } from '@/lib/queries/settings';
import { getUserTeams } from '@/lib/queries/teams';
import { SettingsClient } from './_components/settings-client';

export const metadata: Metadata = {
  title: 'Settings',
};

export default async function SettingsPage() {
  const [user, teams] = await Promise.all([
    getUserWithPreferences(),
    getUserTeams(),
  ]);

  if (!user) {
    return (
      <div className="flex items-center justify-center py-20">
        <p className="text-text-muted">Please log in to access settings.</p>
      </div>
    );
  }

  // Get settings for first team (or team from preferences)
  let team = null;
  let teamIsAdmin = false;

  if (teams.length > 0) {
    const teamId = teams[0].id;
    [team, teamIsAdmin] = await Promise.all([
      getTeamWithSettings(teamId),
      isTeamAdmin(teamId),
    ]);
  }

  return (
    <div className="animate-fade-in space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="mt-1 text-text-secondary">
          Manage your account and preferences
        </p>
      </div>

      <SettingsClient
        user={user}
        team={team}
        teams={teams}
        isAdmin={teamIsAdmin}
      />
    </div>
  );
}
