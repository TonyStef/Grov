import type { Metadata } from 'next';
import { getUserWithPreferences, getTeamWithSettings, isTeamAdmin } from '@/lib/queries/settings';
import { getUserTeams } from '@/lib/queries/teams';
import { getCurrentTeamId } from '@/lib/queries/current-team';
import { getSubscription, isTeamOwner, getTeamUsage, getUsageBreakdown } from '@/lib/queries/billing';
import { SettingsClient } from './_components/settings-client';

export const metadata: Metadata = {
  title: 'Settings',
};

export default async function SettingsPage() {
  const [user, teams, currentTeamId] = await Promise.all([
    getUserWithPreferences(),
    getUserTeams(),
    getCurrentTeamId(),
  ]);

  if (!user) {
    return (
      <div className="flex items-center justify-center p-8 py-20">
        <p className="text-text-quiet">Please log in to access settings.</p>
      </div>
    );
  }

  let team = null;
  let teamIsAdmin = false;
  let teamIsOwner = false;
  let subscription = null;
  let usage = null;
  let usageBreakdown = null;

  if (currentTeamId) {
    [team, teamIsAdmin, teamIsOwner, subscription, usage, usageBreakdown] = await Promise.all([
      getTeamWithSettings(currentTeamId),
      isTeamAdmin(currentTeamId),
      isTeamOwner(currentTeamId),
      getSubscription(currentTeamId),
      getTeamUsage(currentTeamId),
      getUsageBreakdown(currentTeamId),
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
        isOwner={teamIsOwner}
        subscription={subscription}
        usage={usage}
        usageBreakdown={usageBreakdown}
      />
    </div>
  );
}
