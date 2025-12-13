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
import { ConfirmModal } from './confirm-modal';
import { removeMember, cancelInvite, changeRole } from '../actions';

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
  const [confirmAction, setConfirmAction] = useState<{
    type: 'remove' | 'cancel-invite';
    id: string;
    name?: string;
  } | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const handleRemoveMember = (userId: string) => {
    const member = members.find((m) => m.user_id === userId);
    setConfirmAction({
      type: 'remove',
      id: userId,
      name: member?.full_name || member?.email,
    });
  };

  const handleChangeRole = async (userId: string, newRole: 'admin' | 'member') => {
    setIsProcessing(true);
    const result = await changeRole(team.id, userId, newRole);
    setIsProcessing(false);

    if (result.error) {
      setError(result.error);
      setTimeout(() => setError(null), 3000);
    } else {
      router.refresh();
    }
  };

  const handleCancelInvite = (inviteId: string) => {
    setConfirmAction({ type: 'cancel-invite', id: inviteId });
  };

  const handleConfirmAction = async () => {
    if (!confirmAction) return;

    setIsProcessing(true);
    let result;

    if (confirmAction.type === 'remove') {
      result = await removeMember(team.id, confirmAction.id);
    } else {
      result = await cancelInvite(confirmAction.id);
    }

    setIsProcessing(false);
    setConfirmAction(null);

    if (result.error) {
      setError(result.error);
      setTimeout(() => setError(null), 3000);
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
        onChangeRole={handleChangeRole}
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

      <ConfirmModal
        isOpen={!!confirmAction}
        onClose={() => setConfirmAction(null)}
        onConfirm={handleConfirmAction}
        isLoading={isProcessing}
        title={
          confirmAction?.type === 'remove'
            ? 'Remove Team Member'
            : 'Cancel Invitation'
        }
        description={
          confirmAction?.type === 'remove'
            ? `Are you sure you want to remove ${confirmAction.name || 'this member'} from the team? They will lose access to all team resources.`
            : 'Are you sure you want to cancel this invitation? The invite link will no longer work.'
        }
        confirmText={confirmAction?.type === 'remove' ? 'Remove' : 'Cancel Invite'}
      />

      {linkCopied && (
        <div className="fixed bottom-4 right-4 rounded-md bg-success px-4 py-2 text-sm font-medium text-bg-0 shadow-lg animate-fade-in">
          Invite link copied to clipboard!
        </div>
      )}

      {error && (
        <div className="fixed bottom-4 right-4 rounded-md bg-error px-4 py-2 text-sm font-medium text-white shadow-lg animate-fade-in">
          {error}
        </div>
      )}
    </div>
  );
}
