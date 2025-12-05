'use client';

import { UserPlus } from 'lucide-react';
import type { Team } from '@grov/shared';

interface TeamHeaderProps {
  team: Team;
  userRole: string | null;
  onInvite: () => void;
}

export function TeamHeader({ team, userRole, onInvite }: TeamHeaderProps) {
  const canInvite = userRole === 'owner' || userRole === 'admin';

  return (
    <div className="flex items-center justify-between">
      <div>
        <h1 className="text-2xl font-semibold">{team.name}</h1>
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
