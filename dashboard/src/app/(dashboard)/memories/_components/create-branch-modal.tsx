'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { X, Loader2, GitBranch } from 'lucide-react';
import { createBranch } from '../actions';

interface CreateBranchModalProps {
  isOpen: boolean;
  onClose: () => void;
  teamId: string;
}

export function CreateBranchModal({ isOpen, onClose, teamId }: CreateBranchModalProps) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!name.trim()) {
      setError('Branch name is required');
      return;
    }

    startTransition(async () => {
      const result = await createBranch(teamId, name.trim());

      if (result.error) {
        setError(result.error);
      } else {
        handleClose();
        router.refresh();
      }
    });
  };

  const handleClose = () => {
    setName('');
    setError(null);
    onClose();
  };

  // Auto-format branch name as user types
  const handleNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value
      .toLowerCase()
      .replace(/\s+/g, '-') // spaces to dashes
      .replace(/[^a-z0-9/_-]/g, ''); // remove invalid chars
    setName(value);
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
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-leaf/10">
              <GitBranch className="h-5 w-5 text-leaf" />
            </div>
            <h2 className="text-lg font-semibold">Create Branch</h2>
          </div>
          <button
            onClick={handleClose}
            className="rounded p-1 text-text-quiet hover:bg-bark hover:text-text-calm transition-colors"
            aria-label="Close modal"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <p className="text-sm text-text-calm mb-6">
          Create a new branch to isolate experimental work. Memories in this branch
          won&apos;t appear in main until you merge them.
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label
              htmlFor="branch-name"
              className="block text-xs font-medium text-text-calm mb-1.5"
            >
              Branch name
            </label>
            <input
              id="branch-name"
              type="text"
              name="name"
              value={name}
              onChange={handleNameChange}
              placeholder="feat/new-feature"
              autoComplete="off"
              spellCheck={false}
              className="w-full rounded-md border border-border bg-bark px-4 py-2 text-sm text-text-bright placeholder:text-text-quiet focus:border-leaf/50 focus:outline-none transition-all"
            />
            <p className="mt-1 text-[11px] text-text-quiet">
              Use letters, numbers, hyphens, underscores, or slashes
            </p>
          </div>

          {error && (
            <div className="rounded-md bg-error/10 px-4 py-3 text-sm text-error">
              {error}
            </div>
          )}

          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={handleClose}
              disabled={isPending}
              className="rounded-md px-4 py-2 text-sm font-medium text-text-calm hover:bg-bark transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isPending || !name.trim()}
              className="flex items-center gap-2 rounded-md bg-leaf px-4 py-2 text-sm font-medium text-soil hover:bg-bloom transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              Create Branch
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
