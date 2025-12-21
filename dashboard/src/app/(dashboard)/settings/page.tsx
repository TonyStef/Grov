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
      <div className="flex items-center justify-center p-8 py-20">
        <p className="text-text-quiet">Please log in to access settings.</p>
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
    <div className="animate-grow-in space-y-4 p-6">
      <header>
        <h1 className="text-xl font-semibold">Settings</h1>
        <p className="text-sm text-text-calm">
          Manage your account and preferences
        </p>
      </header>

      <SettingsClient
        user={user}
        team={team}
        teams={teams}
        isAdmin={teamIsAdmin}
      />
    </div>
  );
}
