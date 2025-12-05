'use client';

import { useState } from 'react';
import { X, Loader2, Copy, Check, Link2 } from 'lucide-react';
import { createInvite } from '../actions';

interface InviteMemberModalProps {
  isOpen: boolean;
  onClose: () => void;
  teamId: string;
}

export function InviteMemberModal({ isOpen, onClose, teamId }: InviteMemberModalProps) {
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  if (!isOpen) return null;

  const handleGenerateInvite = async () => {
    setError(null);
    setIsLoading(true);

    try {
      const result = await createInvite(teamId);

      if (result.error) {
        setError(result.error);
      } else if (result.inviteUrl) {
        setInviteUrl(result.inviteUrl);
      }
    } catch (err) {
      setError('Something went wrong. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleCopy = async () => {
    if (!inviteUrl) return;

    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      // Fallback for older browsers
      const textArea = document.createElement('textarea');
      textArea.value = inviteUrl;
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand('copy');
      document.body.removeChild(textArea);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleClose = () => {
    setInviteUrl(null);
    setError(null);
    setCopied(false);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-bg-0/80 backdrop-blur-sm"
        onClick={handleClose}
      />

      {/* Modal */}
      <div className="relative w-full max-w-md rounded-lg border border-border bg-bg-1 p-6 shadow-xl">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Invite Team Member</h2>
          <button
            onClick={handleClose}
            className="rounded p-1 text-text-muted hover:bg-bg-2 hover:text-text-primary"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {!inviteUrl ? (
          <div className="space-y-4">
            <p className="text-sm text-text-secondary">
              Generate a unique invite link to share with your team member. The
              link will expire in 7 days.
            </p>

            {error && (
              <div className="rounded-md bg-error/10 px-4 py-3 text-sm text-error">
                {error}
              </div>
            )}

            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={handleClose}
                disabled={isLoading}
                className="rounded-md px-4 py-2 text-sm font-medium text-text-secondary hover:bg-bg-2 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleGenerateInvite}
                disabled={isLoading}
                className="flex items-center gap-2 rounded-md bg-accent-400 px-4 py-2 text-sm font-medium text-bg-0 transition-colors hover:bg-accent-500 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Link2 className="h-4 w-4" />
                )}
                Generate Invite Link
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-text-secondary">
              Share this link with your team member. They'll need to log in with
              GitHub to join.
            </p>

            <div className="flex items-center gap-2">
              <div className="flex-1 rounded-md bg-bg-2 px-4 py-2">
                <p className="text-sm font-mono text-text-primary truncate">
                  {inviteUrl}
                </p>
              </div>
              <button
                onClick={handleCopy}
                className="flex items-center gap-2 rounded-md bg-bg-2 px-4 py-2 text-sm font-medium text-text-primary hover:bg-bg-3 transition-colors"
              >
                {copied ? (
                  <>
                    <Check className="h-4 w-4 text-success" />
                    Copied!
                  </>
                ) : (
                  <>
                    <Copy className="h-4 w-4" />
                    Copy
                  </>
                )}
              </button>
            </div>

            <div className="rounded-md bg-warning/10 px-4 py-3 text-sm text-warning">
              This link will expire in 7 days and can only be used once.
            </div>

            <div className="flex justify-end pt-2">
              <button
                onClick={handleClose}
                className="rounded-md px-4 py-2 text-sm font-medium text-text-secondary hover:bg-bg-2 transition-colors"
              >
                Done
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
