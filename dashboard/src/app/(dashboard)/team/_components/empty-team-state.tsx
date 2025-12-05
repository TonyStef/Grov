'use client';

import { Users } from 'lucide-react';

interface EmptyTeamStateProps {
  onCreateTeam: () => void;
}

export function EmptyTeamState({ onCreateTeam }: EmptyTeamStateProps) {
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] p-8">
      <div className="flex h-16 w-16 items-center justify-center rounded-full bg-accent-400/10">
        <Users className="h-8 w-8 text-accent-400" />
      </div>
      <h2 className="mt-6 text-2xl font-bold text-text-primary">
        Create Your Team
      </h2>
      <p className="mt-2 text-center text-text-secondary max-w-md">
        Teams let you share AI reasoning with your collaborators. Create a team
        to start capturing and organizing memories from your Claude Code sessions.
      </p>
      <button
        onClick={onCreateTeam}
        className="mt-6 inline-flex items-center rounded-md bg-accent-400 px-6 py-3 text-sm font-medium text-bg-0 transition-colors hover:bg-accent-500"
      >
        Create Team
      </button>
      <div className="mt-8 rounded-lg border border-border bg-bg-1 p-6 max-w-md">
        <h3 className="font-medium mb-3">What you can do with teams:</h3>
        <ul className="space-y-2 text-sm text-text-secondary">
          <li className="flex items-start gap-2">
            <span className="text-accent-400 mt-0.5">•</span>
            <span>Share reasoning traces with your team</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-accent-400 mt-0.5">•</span>
            <span>Search across all team memories</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-accent-400 mt-0.5">•</span>
            <span>Invite collaborators via shareable links</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-accent-400 mt-0.5">•</span>
            <span>Enable automatic sync from the CLI</span>
          </li>
        </ul>
      </div>
    </div>
  );
}
