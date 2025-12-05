'use client';

import { useState } from 'react';
import { X, Loader2 } from 'lucide-react';
import { createTeam } from '../actions';

interface CreateTeamModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: (teamId: string) => void;
}

export function CreateTeamModal({ isOpen, onClose, onSuccess }: CreateTeamModalProps) {
  const [teamName, setTeamName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      const formData = new FormData();
      formData.set('name', teamName);

      const result = await createTeam(formData);

      if (result.error) {
        setError(result.error);
      } else if (result.team) {
        onSuccess?.(result.team.id);
        onClose();
        setTeamName('');
      }
    } catch (err) {
      setError('Something went wrong. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-bg-0/80 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="relative w-full max-w-md rounded-lg border border-border bg-bg-1 p-6 shadow-xl">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Create Team</h2>
          <button
            onClick={onClose}
            className="rounded p-1 text-text-muted hover:bg-bg-2 hover:text-text-primary"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="space-y-4">
            <div>
              <label
                htmlFor="team-name"
                className="block text-sm font-medium text-text-secondary mb-1"
              >
                Team Name
              </label>
              <input
                id="team-name"
                type="text"
                value={teamName}
                onChange={(e) => setTeamName(e.target.value)}
                placeholder="My Awesome Team"
                className="w-full rounded-md border border-border bg-bg-2 px-4 py-2 text-text-primary placeholder:text-text-muted focus:border-accent-400 focus:outline-none focus:ring-1 focus:ring-accent-400"
                required
                minLength={2}
                maxLength={50}
                disabled={isSubmitting}
              />
              <p className="mt-1 text-xs text-text-muted">
                Choose a name that describes your team or project
              </p>
            </div>

            {error && (
              <div className="rounded-md bg-error/10 px-4 py-3 text-sm text-error">
                {error}
              </div>
            )}

            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={onClose}
                disabled={isSubmitting}
                className="rounded-md px-4 py-2 text-sm font-medium text-text-secondary hover:bg-bg-2 transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isSubmitting || !teamName.trim()}
                className="flex items-center gap-2 rounded-md bg-accent-400 px-4 py-2 text-sm font-medium text-bg-0 transition-colors hover:bg-accent-500 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isSubmitting && <Loader2 className="h-4 w-4 animate-spin" />}
                Create Team
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
