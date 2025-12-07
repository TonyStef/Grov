'use client';

import { useState, useTransition } from 'react';
import { deleteAccount } from '../actions';
import { useRouter } from 'next/navigation';

export function DangerZone() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [showConfirm, setShowConfirm] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [error, setError] = useState<string | null>(null);

  const handleDelete = () => {
    if (confirmText !== 'DELETE') return;
    setError(null);

    startTransition(async () => {
      const result = await deleteAccount();
      if (result.error) {
        setError(result.error);
        setShowConfirm(false);
        setConfirmText('');
      } else {
        router.push('/login');
      }
    });
  };

  return (
    <div className="rounded-lg border border-error/50 bg-error/5 p-6">
      <h2 className="mb-2 text-lg font-medium text-error">Danger Zone</h2>
      <p className="mb-4 text-sm text-text-secondary">
        Once you delete your account, there is no going back. All your data will be permanently
        removed.
      </p>

      {error && (
        <div className="mb-4 rounded-md bg-error/10 px-4 py-2 text-sm text-error">{error}</div>
      )}

      {!showConfirm ? (
        <button
          onClick={() => setShowConfirm(true)}
          className="rounded-md border border-error px-4 py-2 text-sm font-medium text-error transition-colors hover:bg-error hover:text-white"
        >
          Delete Account
        </button>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-text-secondary">
            Type <span className="font-mono font-bold text-error">DELETE</span> to confirm:
          </p>
          <input
            type="text"
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder="Type DELETE"
            className="w-full rounded-md border border-error/50 bg-bg-2 px-4 py-2 text-sm focus:border-error focus:outline-none focus:ring-1 focus:ring-error"
          />
          <div className="flex gap-2">
            <button
              onClick={handleDelete}
              disabled={isPending || confirmText !== 'DELETE'}
              className="rounded-md bg-error px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-error/90 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isPending ? 'Deleting...' : 'Confirm Delete'}
            </button>
            <button
              onClick={() => {
                setShowConfirm(false);
                setConfirmText('');
              }}
              className="rounded-md border border-border px-4 py-2 text-sm font-medium text-text-secondary transition-colors hover:bg-bg-2"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
