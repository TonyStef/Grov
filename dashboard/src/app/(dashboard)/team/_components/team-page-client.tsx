'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Team } from '@grov/shared';
import type { TeamMemberWithProfile } from '@/lib/queries/teams';
import { TeamHeader } from './team-header';
import { TeamMembersTable } from './team-members-table';
import { PendingInvitations } from './pending-invitations';
import { EmptyTeamState } from './empty-team-state';
import { CreateTeamModal } from './create-team-modal';
import { InviteMemberModal } from './invite-member-modal';
import { removeMember, cancelInvite } from '../actions';

interface Invitation {
  id: string;
  invite_code: string;
  expires_at: string;
  created_at: string;
  creator?: {
    email: string;
    full_name: string | null;
  };
}

interface TeamPageClientProps {
  team: Team | null;
  members: TeamMemberWithProfile[];
  invitations: Invitation[];
  currentUserId: string;
  userRole: string | null;
}

export function TeamPageClient({
  team,
  members,
  invitations,
  currentUserId,
  userRole,
}: TeamPageClientProps) {
  const router = useRouter();
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);

  // No team - show empty state
  if (!team) {
    return (
      <>
        <EmptyTeamState onCreateTeam={() => setShowCreateModal(true)} />
        <CreateTeamModal
          isOpen={showCreateModal}
          onClose={() => setShowCreateModal(false)}
          onSuccess={() => {
            router.refresh();
          }}
        />
      </>
    );
  }

  const handleRemoveMember = async (userId: string) => {
    if (!confirm('Are you sure you want to remove this member from the team?')) {
      return;
    }

    const result = await removeMember(team.id, userId);
    if (result.error) {
      alert(result.error);
    } else {
      router.refresh();
    }
  };

  const handleCancelInvite = async (inviteId: string) => {
    if (!confirm('Are you sure you want to cancel this invitation?')) {
      return;
    }

    const result = await cancelInvite(inviteId);
    if (result.error) {
      alert(result.error);
    } else {
      router.refresh();
    }
  };

  const handleLinkCopied = () => {
    setLinkCopied(true);
    setTimeout(() => setLinkCopied(false), 2000);
  };

  const canManage = userRole === 'owner' || userRole === 'admin';

  return (
    <div className="animate-fade-in space-y-6">
      <TeamHeader
        team={team}
        userRole={userRole}
        onInvite={() => setShowInviteModal(true)}
      />

      <TeamMembersTable
        members={members}
        currentUserId={currentUserId}
        userRole={userRole}
        onRemoveMember={handleRemoveMember}
      />

      {canManage && (
        <PendingInvitations
          invitations={invitations}
          onCopyLink={handleLinkCopied}
          onCancelInvite={handleCancelInvite}
          canManage={canManage}
        />
      )}

      <InviteMemberModal
        isOpen={showInviteModal}
        onClose={() => setShowInviteModal(false)}
        teamId={team.id}
      />

      {/* Toast for link copied */}
      {linkCopied && (
        <div className="fixed bottom-4 right-4 rounded-md bg-success px-4 py-2 text-sm font-medium text-bg-0 shadow-lg animate-fade-in">
          Invite link copied to clipboard!
        </div>
      )}
    </div>
  );
}
