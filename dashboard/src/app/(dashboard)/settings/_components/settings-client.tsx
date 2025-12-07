'use client';

import { useState } from 'react';
import type { UserWithPreferences, TeamWithSettings } from '@/lib/queries/settings';
import type { TeamWithMemberCount } from '@/lib/queries/teams';
import { ProfileSettings } from './profile-settings';
import { TeamSettings } from './team-settings';
import { PreferencesSettings } from './preferences-settings';
import { NotificationsSettings } from './notifications-settings';
import { ApiKeysPlaceholder } from './api-keys-placeholder';
import { BillingPlaceholder } from './billing-placeholder';
import { DangerZone } from './danger-zone';

type Tab = 'profile' | 'team' | 'preferences' | 'notifications' | 'api' | 'billing';

interface SettingsClientProps {
  user: UserWithPreferences;
  team: TeamWithSettings | null;
  teams: TeamWithMemberCount[];
  isAdmin: boolean;
}

const tabs: { id: Tab; label: string }[] = [
  { id: 'profile', label: 'Profile' },
  { id: 'team', label: 'Team Settings' },
  { id: 'preferences', label: 'Preferences' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'api', label: 'API Keys' },
  { id: 'billing', label: 'Billing' },
];

export function SettingsClient({ user, team, teams, isAdmin }: SettingsClientProps) {
  const [activeTab, setActiveTab] = useState<Tab>('profile');

  return (
    <div className="grid gap-6 lg:grid-cols-4">
      {/* Navigation */}
      <nav className="space-y-1">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`block w-full rounded-md px-4 py-2 text-left text-sm font-medium transition-colors ${
              activeTab === tab.id
                ? 'bg-accent-400/10 text-accent-400'
                : 'text-text-secondary hover:bg-bg-2 hover:text-text-primary'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {/* Content */}
      <div className="space-y-6 lg:col-span-3">
        {activeTab === 'profile' && (
          <>
            <ProfileSettings user={user} />
            <DangerZone />
          </>
        )}

        {activeTab === 'team' && (
          team ? (
            <TeamSettings team={team} isAdmin={isAdmin} />
          ) : (
            <div className="rounded-lg border border-border bg-bg-1 p-6">
              <h2 className="mb-4 text-lg font-medium">Team Settings</h2>
              <p className="text-sm text-text-muted">
                You are not a member of any team yet. Create or join a team to access team settings.
              </p>
              <a
                href="/team"
                className="mt-4 inline-block rounded-md bg-accent-400 px-4 py-2 text-sm font-medium text-bg-0 transition-colors hover:bg-accent-500"
              >
                Go to Teams
              </a>
            </div>
          )
        )}

        {activeTab === 'preferences' && (
          <PreferencesSettings teams={teams} />
        )}

        {activeTab === 'notifications' && (
          <NotificationsSettings />
        )}

        {activeTab === 'api' && (
          <ApiKeysPlaceholder />
        )}

        {activeTab === 'billing' && (
          <BillingPlaceholder />
        )}
      </div>
    </div>
  );
}
