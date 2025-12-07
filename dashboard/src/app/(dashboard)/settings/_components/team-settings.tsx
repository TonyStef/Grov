'use client';

import { useState, useTransition } from 'react';
import { updateTeamName, updateTeamSettings } from '../actions';
import type { TeamWithSettings } from '@/lib/queries/settings';

interface TeamSettingsProps {
  team: TeamWithSettings;
  isAdmin: boolean;
}

export function TeamSettings({ team, isAdmin }: TeamSettingsProps) {
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Form state
  const [teamName, setTeamName] = useState(team.name);
  const [autoSync, setAutoSync] = useState(team.settings.auto_sync ?? true);
  const [retentionDays, setRetentionDays] = useState(team.settings.retention_days ?? 90);
  const [tagsInput, setTagsInput] = useState((team.settings.default_tags || []).join(', '));

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setMessage(null);

    // Parse tags
    const tags = tagsInput
      .split(',')
      .map((tag) => tag.trim().toLowerCase())
      .filter((tag) => tag.length > 0);

    startTransition(async () => {
      // Update team name if changed
      if (teamName !== team.name) {
        const nameResult = await updateTeamName(team.id, teamName);
        if (nameResult.error) {
          setMessage({ type: 'error', text: nameResult.error });
          return;
        }
      }

      // Update settings
      const settingsResult = await updateTeamSettings(team.id, {
        auto_sync: autoSync,
        retention_days: retentionDays,
        default_tags: tags,
      });

      if (settingsResult.error) {
        setMessage({ type: 'error', text: settingsResult.error });
      } else {
        setMessage({ type: 'success', text: 'Team settings updated successfully' });
      }
    });
  };

  if (!isAdmin) {
    return (
      <div className="rounded-lg border border-border bg-bg-1 p-6">
        <h2 className="mb-4 text-lg font-medium">Team Settings</h2>
        <p className="text-sm text-text-secondary">
          Only team admins and owners can modify team settings.
        </p>
        <div className="mt-4 space-y-3 text-sm">
          <div>
            <span className="text-text-muted">Team name:</span>{' '}
            <span className="text-text-primary">{team.name}</span>
          </div>
          <div>
            <span className="text-text-muted">Auto-sync:</span>{' '}
            <span className="text-text-primary">{team.settings.auto_sync ? 'Enabled' : 'Disabled'}</span>
          </div>
          <div>
            <span className="text-text-muted">Retention:</span>{' '}
            <span className="text-text-primary">{team.settings.retention_days} days</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border bg-bg-1 p-6">
      <h2 className="mb-6 text-lg font-medium">Team Settings</h2>

      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Team Name */}
        <div>
          <label htmlFor="team_name" className="mb-2 block text-sm text-text-secondary">
            Team Name
          </label>
          <input
            id="team_name"
            type="text"
            value={teamName}
            onChange={(e) => setTeamName(e.target.value)}
            placeholder="My Team"
            maxLength={50}
            className="w-full rounded-md border border-border bg-bg-2 px-4 py-2 text-sm placeholder:text-text-muted focus:border-accent-400 focus:outline-none focus:ring-1 focus:ring-accent-400"
          />
        </div>

        {/* Default Tags */}
        <div>
          <label htmlFor="default_tags" className="mb-2 block text-sm text-text-secondary">
            Default Tags
          </label>
          <input
            id="default_tags"
            type="text"
            value={tagsInput}
            onChange={(e) => setTagsInput(e.target.value)}
            placeholder="bug, feature, refactor"
            className="w-full rounded-md border border-border bg-bg-2 px-4 py-2 text-sm placeholder:text-text-muted focus:border-accent-400 focus:outline-none focus:ring-1 focus:ring-accent-400"
          />
          <p className="mt-1 text-xs text-text-muted">
            Comma-separated tags to auto-apply to new memories
          </p>
        </div>

        {/* Auto Sync Toggle */}
        <div className="flex items-center justify-between">
          <div>
            <label htmlFor="auto_sync" className="text-sm text-text-secondary">
              Auto-sync
            </label>
            <p className="text-xs text-text-muted">
              Automatically sync memories from CLI
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={autoSync}
            onClick={() => setAutoSync(!autoSync)}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
              autoSync ? 'bg-accent-400' : 'bg-bg-3'
            }`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                autoSync ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
        </div>

        {/* Retention Days */}
        <div>
          <label htmlFor="retention_days" className="mb-2 block text-sm text-text-secondary">
            Memory Retention
          </label>
          <div className="flex items-center gap-3">
            <input
              id="retention_days"
              type="number"
              min={1}
              max={365}
              value={retentionDays}
              onChange={(e) => setRetentionDays(parseInt(e.target.value) || 90)}
              className="w-24 rounded-md border border-border bg-bg-2 px-4 py-2 text-sm focus:border-accent-400 focus:outline-none focus:ring-1 focus:ring-accent-400"
            />
            <span className="text-sm text-text-secondary">days</span>
          </div>
          <p className="mt-1 text-xs text-text-muted">
            How long to keep memories before auto-archiving (1-365 days)
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

        {/* Submit */}
        <div className="pt-4">
          <button
            type="submit"
            disabled={isPending}
            className="rounded-md bg-accent-400 px-4 py-2 text-sm font-medium text-bg-0 transition-colors hover:bg-accent-500 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isPending ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      </form>
    </div>
  );
}
