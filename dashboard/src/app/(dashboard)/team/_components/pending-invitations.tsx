'use client';

import { Link2, X, Clock } from 'lucide-react';
import { formatRelativeDate } from '@/lib/utils';

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

interface PendingInvitationsProps {
  invitations: Invitation[];
  onCopyLink?: (code: string) => void;
  onCancelInvite?: (id: string) => void;
  canManage?: boolean;
}

export function PendingInvitations({
  invitations,
  onCopyLink,
  onCancelInvite,
  canManage = false,
}: PendingInvitationsProps) {
  const copyToClipboard = (code: string) => {
    const url = `${window.location.origin}/invite/${code}`;
    navigator.clipboard.writeText(url);
    onCopyLink?.(code);
  };

  const getTimeRemaining = (expiresAt: string) => {
    const expiry = new Date(expiresAt);
    const now = new Date();
    const diffMs = expiry.getTime() - now.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));

    if (diffDays > 0) return `${diffDays} days left`;
    if (diffHours > 0) return `${diffHours} hours left`;
    return 'Expiring soon';
  };

  return (
    <div className="rounded-lg border border-border bg-bg-1 p-6">
      <h2 className="mb-4 font-medium">Pending Invitations</h2>

      {invitations.length === 0 ? (
        <p className="text-sm text-text-muted">No pending invitations</p>
      ) : (
        <div className="space-y-3">
          {invitations.map((invitation) => (
            <div
              key={invitation.id}
              className="flex items-center justify-between rounded-md bg-bg-2 px-4 py-3"
            >
              <div className="flex items-center gap-3">
                <div className="flex h-8 w-8 items-center justify-center rounded bg-bg-3">
                  <Link2 className="h-4 w-4 text-text-muted" />
                </div>
                <div>
                  <p className="text-sm font-medium font-mono">
                    {invitation.invite_code.slice(0, 8)}...
                  </p>
                  <div className="flex items-center gap-2 text-xs text-text-muted">
                    <Clock className="h-3 w-3" />
                    <span>{getTimeRemaining(invitation.expires_at)}</span>
                    {invitation.creator && (
                      <>
                        <span>•</span>
                        <span>
                          Created by {invitation.creator.full_name || invitation.creator.email}
                        </span>
                      </>
                    )}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => copyToClipboard(invitation.invite_code)}
                  className="rounded px-3 py-1.5 text-xs font-medium text-accent-400 hover:bg-accent-400/10 transition-colors"
                >
                  Copy Link
                </button>
                {canManage && (
                  <button
                    onClick={() => onCancelInvite?.(invitation.id)}
                    className="rounded p-1.5 text-text-muted hover:bg-error/10 hover:text-error transition-colors"
                    title="Cancel invitation"
                  >
                    <X className="h-4 w-4" />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
