'use client';

import { useState } from 'react';
import { UserPlus, Copy, Check } from 'lucide-react';
import type { Team } from '@grov/shared';

interface TeamHeaderProps {
  team: Team;
  userRole: string | null;
  onInvite: () => void;
}

export function TeamHeader({ team, userRole, onInvite }: TeamHeaderProps) {
  const canInvite = userRole === 'owner' || userRole === 'admin';
  const [copied, setCopied] = useState(false);

  const handleCopyId = async () => {
    await navigator.clipboard.writeText(team.id);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="flex items-center justify-between">
      <div>
        <h1 className="text-2xl font-semibold">{team.name}</h1>
        <div className="mt-1 flex items-center gap-2">
          <span className="text-xs text-text-muted">Team ID:</span>
          <button
            onClick={handleCopyId}
            className="flex items-center gap-1.5 rounded bg-bg-2 px-2 py-0.5 font-mono text-xs text-text-secondary transition-colors hover:bg-bg-3 hover:text-text-primary"
            title="Click to copy"
          >
            <span className="max-w-[200px] truncate">{team.id}</span>
            {copied ? (
              <Check className="h-3 w-3 text-success" />
            ) : (
              <Copy className="h-3 w-3" />
            )}
          </button>
        </div>
        <p className="mt-1 text-text-secondary">
          Manage your team members and invitations
        </p>
      </div>
      {canInvite && (
        <button
          onClick={onInvite}
          className="flex items-center gap-2 rounded-md bg-accent-400 px-4 py-2 text-sm font-medium text-bg-0 transition-colors hover:bg-accent-500"
        >
          <UserPlus className="h-4 w-4" />
          Invite Member
        </button>
      )}
    </div>
  );
}
