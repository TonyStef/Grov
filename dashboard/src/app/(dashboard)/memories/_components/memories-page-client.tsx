'use client';

import { useState } from 'react';
import { BranchSelector } from './branch-selector';
import { CreateBranchModal } from './create-branch-modal';
import { InviteToBranchModal } from './invite-to-branch-modal';
import type { Branch } from '@/lib/queries/branches';

interface TeamMember {
  user_id: string;
  email: string;
  full_name: string | null;
  avatar_url: string | null;
}

interface MemoriesPageClientProps {
  teamId: string;
  branches: Branch[];
  activeBranch: string;
  userRole: string | null;
  teamMembers: TeamMember[];
}

export function MemoriesPageClient({
  teamId,
  branches,
  activeBranch,
  userRole,
  teamMembers,
}: MemoriesPageClientProps) {
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [inviteBranchName, setInviteBranchName] = useState<string | null>(null);

  return (
    <>
      <BranchSelector
        branches={branches}
        activeBranch={activeBranch}
        teamId={teamId}
        userRole={userRole}
        onCreateBranch={() => setIsCreateModalOpen(true)}
        onInviteToBranch={(name) => setInviteBranchName(name)}
      />

      <CreateBranchModal
        isOpen={isCreateModalOpen}
        onClose={() => setIsCreateModalOpen(false)}
        teamId={teamId}
      />

      {inviteBranchName && (
        <InviteToBranchModal
          isOpen={!!inviteBranchName}
          onClose={() => setInviteBranchName(null)}
          teamId={teamId}
          branchName={inviteBranchName}
          teamMembers={teamMembers}
        />
      )}
    </>
  );
}
