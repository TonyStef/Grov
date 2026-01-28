'use client';

import { useState } from 'react';
import { Plus } from 'lucide-react';
import { CreatePlanModal } from './create-plan-modal';

interface TeamMember {
  user_id: string;
  email: string;
  full_name: string | null;
  avatar_url: string | null;
}

interface PlansPageClientProps {
  teamId: string;
  teamMembers: TeamMember[];
}

export function PlansPageClient({ teamId, teamMembers }: PlansPageClientProps) {
  const [showCreateModal, setShowCreateModal] = useState(false);

  return (
    <>
      <button
        onClick={() => setShowCreateModal(true)}
        className="flex items-center gap-1.5 rounded-lg bg-leaf px-3 py-1.5 text-xs font-medium text-soil hover:bg-bloom transition-all"
      >
        <Plus className="h-3.5 w-3.5" />
        New Plan
      </button>

      {showCreateModal && (
        <CreatePlanModal
          teamId={teamId}
          teamMembers={teamMembers}
          onClose={() => setShowCreateModal(false)}
        />
      )}
    </>
  );
}

