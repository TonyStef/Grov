'use client';

import { Users } from 'lucide-react';

interface EmptyTeamStateProps {
  onCreateTeam: () => void;
}

export function EmptyTeamState({ onCreateTeam }: EmptyTeamStateProps) {
  return (
    <div className="flex flex-col items-center justify-center min-h-[50vh] p-6">
      <Users className="h-8 w-8 text-leaf mb-3" />
      <h2 className="text-lg font-semibold text-text-bright">
        Create Your Team
      </h2>
      <p className="mt-2 text-center text-xs text-text-calm max-w-sm">
        Teams let you share AI reasoning with collaborators.
      </p>
      <button
        onClick={onCreateTeam}
        className="mt-4 inline-flex items-center rounded-md bg-leaf px-4 py-1.5 text-xs font-medium text-soil hover:bg-bloom transition-all"
      >
        Create Team
      </button>
      <div className="mt-6 rounded-lg border border-border bg-root p-4 max-w-sm">
        <h3 className="text-xs font-semibold text-text-bright mb-2">With teams you can:</h3>
        <ul className="space-y-1.5 text-[11px] text-text-calm">
          <li className="flex items-start gap-2">
            <span className="text-leaf">•</span>
            <span>Share reasoning traces</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-leaf">•</span>
            <span>Search all team memories</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-leaf">•</span>
            <span>Invite collaborators</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-leaf">•</span>
            <span>Auto-sync from CLI</span>
          </li>
        </ul>
      </div>
    </div>
  );
}
