'use client';

import { useState, useEffect } from 'react';
import type { TeamWithMemberCount } from '@/lib/queries/teams';

interface PreferencesSettingsProps {
  teams: TeamWithMemberCount[];
}

interface Preferences {
  theme: 'dark' | 'light' | 'system';
  default_team_id: string | null;
}

const STORAGE_KEY = 'grov-preferences';

function loadPreferences(): Preferences {
  if (typeof window === 'undefined') {
    return { theme: 'dark', default_team_id: null };
  }
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      return JSON.parse(stored);
    }
  } catch {
    // Ignore parse errors
  }
  return { theme: 'dark', default_team_id: null };
}

function savePreferences(prefs: Preferences) {
  if (typeof window === 'undefined') return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
}

export function PreferencesSettings({ teams }: PreferencesSettingsProps) {
  const [preferences, setPreferences] = useState<Preferences>({ theme: 'dark', default_team_id: null });
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [mounted, setMounted] = useState(false);

  // Load from localStorage on mount
  useEffect(() => {
    setPreferences(loadPreferences());
    setMounted(true);
  }, []);

  const handleThemeChange = (theme: 'dark' | 'light' | 'system') => {
    const newPrefs = { ...preferences, theme };
    setPreferences(newPrefs);
    savePreferences(newPrefs);
    setMessage({ type: 'success', text: 'Theme preference saved' });
    setTimeout(() => setMessage(null), 2000);
  };

  const handleDefaultTeamChange = (teamId: string) => {
    const newPrefs = { ...preferences, default_team_id: teamId || null };
    setPreferences(newPrefs);
    savePreferences(newPrefs);
    setMessage({ type: 'success', text: 'Default team saved' });
    setTimeout(() => setMessage(null), 2000);
  };

  if (!mounted) {
    return (
      <div className="rounded-lg border border-border bg-bg-1 p-6">
        <h2 className="mb-6 text-lg font-medium">Preferences</h2>
        <div className="animate-pulse space-y-4">
          <div className="h-10 w-full rounded bg-bg-2" />
          <div className="h-10 w-full rounded bg-bg-2" />
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border bg-bg-1 p-6">
      <h2 className="mb-6 text-lg font-medium">Preferences</h2>

      <div className="space-y-6">
        {/* Theme Selection */}
        <div>
          <label className="mb-2 block text-sm text-text-secondary">Theme</label>
          <div className="flex gap-2">
            {(['dark', 'light', 'system'] as const).map((theme) => (
              <button
                key={theme}
                type="button"
                onClick={() => handleThemeChange(theme)}
                className={`rounded-md px-4 py-2 text-sm font-medium capitalize transition-colors ${
                  preferences.theme === theme
                    ? 'bg-accent-400 text-bg-0'
                    : 'bg-bg-2 text-text-secondary hover:bg-bg-3 hover:text-text-primary'
                }`}
              >
                {theme}
              </button>
            ))}
          </div>
          <p className="mt-2 text-xs text-text-muted">
            Theme preference is stored locally. UI theming coming soon.
          </p>
        </div>

        {/* Default Team */}
        <div>
          <label htmlFor="default_team" className="mb-2 block text-sm text-text-secondary">
            Default Team
          </label>
          <select
            id="default_team"
            value={preferences.default_team_id || ''}
            onChange={(e) => handleDefaultTeamChange(e.target.value)}
            className="w-full rounded-md border border-border bg-bg-2 px-4 py-2 text-sm focus:border-accent-400 focus:outline-none focus:ring-1 focus:ring-accent-400"
          >
            <option value="">Select a team...</option>
            {teams.map((team) => (
              <option key={team.id} value={team.id}>
                {team.name}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-text-muted">
            Team to show by default when opening the dashboard
          </p>
        </div>

        {/* Message */}
        {message && (
          <div
            className={`rounded-md px-4 py-2 text-sm ${
              message.type === 'success'
                ? 'bg-success/10 text-success'
                : 'bg-error/10 text-error'
            }`}
          >
            {message.text}
          </div>
        )}
      </div>
    </div>
  );
}
