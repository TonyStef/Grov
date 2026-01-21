'use client';

import { useState, useTransition, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Image from 'next/image';
import { X, Loader2, Users, Check, UserMinus } from 'lucide-react';
import { inviteToBranch, getBranchMembersAction, removeFromBranch } from '../actions';
import { getInitials } from '@/lib/utils';

interface TeamMember {
  user_id: string;
  email: string;
  full_name: string | null;
  avatar_url: string | null;
}

interface BranchMember {
  user_id: string;
  email: string;
  full_name: string | null;
  avatar_url: string | null;
  role: string;
}

interface InviteToBranchModalProps {
  isOpen: boolean;
  onClose: () => void;
  teamId: string;
  branchName: string;
  teamMembers: TeamMember[];
}

export function InviteToBranchModal({
  isOpen,
  onClose,
  teamId,
  branchName,
  teamMembers,
}: InviteToBranchModalProps) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [pendingUserId, setPendingUserId] = useState<string | null>(null);
  const [branchMembers, setBranchMembers] = useState<BranchMember[]>([]);
  const [isLoadingMembers, setIsLoadingMembers] = useState(true);

  useEffect(() => {
    if (!isOpen) return;

    setIsLoadingMembers(true);
    getBranchMembersAction(teamId, branchName).then(result => {
      setBranchMembers(result.members);
      setIsLoadingMembers(false);
    });
  }, [isOpen, teamId, branchName]);

  if (!isOpen) return null;

  const branchMemberIds = new Set(branchMembers.map(m => m.user_id));
  const availableMembers = teamMembers.filter(m => !branchMemberIds.has(m.user_id));

  const handleInvite = (userId: string, userName: string) => {
    setError(null);
    setSuccessMessage(null);
    setPendingUserId(userId);

    startTransition(async () => {
      const result = await inviteToBranch(teamId, branchName, userId);

      if (result.error) {
        setError(result.error);
      } else {
        setSuccessMessage(`${userName} has been added`);
        const updated = await getBranchMembersAction(teamId, branchName);
        setBranchMembers(updated.members);
        router.refresh();
      }
      setPendingUserId(null);
    });
  };

  const handleRemove = (userId: string, userName: string) => {
    setError(null);
    setSuccessMessage(null);
    setPendingUserId(userId);

    startTransition(async () => {
      const result = await removeFromBranch(teamId, branchName, userId);

      if (result.error) {
        setError(result.error);
      } else {
        setSuccessMessage(`${userName} has been removed`);
        const updated = await getBranchMembersAction(teamId, branchName);
        setBranchMembers(updated.members);
        router.refresh();
      }
      setPendingUserId(null);
    });
  };

  const handleClose = () => {
    setError(null);
    setSuccessMessage(null);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="absolute inset-0 bg-bg-0/80 backdrop-blur-sm"
        onClick={handleClose}
        aria-hidden="true"
      />

      <div className="relative w-full max-w-md rounded-lg border border-border bg-bg-1 p-6 shadow-xl">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-leaf/10">
              <Users className="h-5 w-5 text-leaf" />
            </div>
            <div>
              <h2 className="text-lg font-semibold">Branch Members</h2>
              <p className="text-xs text-text-quiet">{branchName}</p>
            </div>
          </div>
          <button
            onClick={handleClose}
            className="rounded p-1 text-text-quiet hover:bg-bark hover:text-text-calm transition-colors"
            aria-label="Close modal"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {error && (
          <div className="mb-4 rounded-md bg-error/10 px-4 py-3 text-sm text-error">
            {error}
          </div>
        )}

        {successMessage && (
          <div className="mb-4 rounded-md bg-success/10 px-4 py-3 text-sm text-success flex items-center gap-2">
            <Check className="h-4 w-4" />
            {successMessage}
          </div>
        )}

        {isLoadingMembers ? (
          <div className="py-8 flex justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-text-quiet" />
          </div>
        ) : (
          <div className="space-y-4">
            {branchMembers.length > 0 && (
              <div>
                <p className="text-xs font-medium text-text-quiet uppercase tracking-wider mb-2">
                  Current Members ({branchMembers.length})
                </p>
                <div className="space-y-1 max-h-32 overflow-y-auto">
                  {branchMembers.map(member => (
                    <div
                      key={member.user_id}
                      className="flex items-center justify-between rounded-md px-3 py-2 bg-bark/50"
                    >
                      <div className="flex items-center gap-3">
                        {member.avatar_url ? (
                          <Image
                            src={member.avatar_url}
                            alt=""
                            width={28}
                            height={28}
                            className="rounded"
                          />
                        ) : (
                          <div className="h-7 w-7 rounded bg-leaf/10 text-[10px] flex items-center justify-center text-leaf font-medium">
                            {getInitials(member.full_name || member.email)}
                          </div>
                        )}
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-text-bright truncate">
                            {member.full_name || member.email}
                          </p>
                        </div>
                      </div>
                      <button
                        onClick={() => handleRemove(member.user_id, member.full_name || member.email)}
                        disabled={isPending}
                        className="p-1.5 rounded text-text-quiet hover:text-error hover:bg-error/10 transition-colors disabled:opacity-50"
                        aria-label={`Remove ${member.full_name || member.email}`}
                      >
                        {pendingUserId === member.user_id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <UserMinus className="h-3.5 w-3.5" />
                        )}
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div>
              <p className="text-xs font-medium text-text-quiet uppercase tracking-wider mb-2">
                Add Members
              </p>
              <div className="max-h-40 overflow-y-auto">
                {availableMembers.length === 0 ? (
                  <div className="py-4 text-center text-sm text-text-quiet">
                    All team members are in this branch
                  </div>
                ) : (
                  <div className="space-y-1">
                    {availableMembers.map(member => (
                      <div
                        key={member.user_id}
                        className="flex items-center justify-between rounded-md px-3 py-2 hover:bg-bark transition-all"
                      >
                        <div className="flex items-center gap-3">
                          {member.avatar_url ? (
                            <Image
                              src={member.avatar_url}
                              alt=""
                              width={28}
                              height={28}
                              className="rounded"
                            />
                          ) : (
                            <div className="h-7 w-7 rounded bg-leaf/10 text-[10px] flex items-center justify-center text-leaf font-medium">
                              {getInitials(member.full_name || member.email)}
                            </div>
                          )}
                          <div className="min-w-0">
                            <p className="text-sm font-medium text-text-bright truncate">
                              {member.full_name || member.email}
                            </p>
                          </div>
                        </div>
                        <button
                          onClick={() => handleInvite(member.user_id, member.full_name || member.email)}
                          disabled={isPending}
                          className="rounded-md bg-bark border border-border px-3 py-1 text-xs font-medium text-text-calm hover:bg-moss hover:border-leaf/30 transition-all disabled:opacity-50"
                        >
                          {pendingUserId === member.user_id ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            'Add'
                          )}
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        <div className="flex justify-end pt-4 border-t border-border mt-4">
          <button
            onClick={handleClose}
            className="rounded-md px-4 py-2 text-sm font-medium text-text-calm hover:bg-bark transition-colors"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
