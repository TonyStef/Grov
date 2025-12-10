'use client';

import { useState, useTransition } from 'react';
import { LogOut } from 'lucide-react';
import { updateProfile } from '../actions';
import { createClient } from '@/lib/supabase/client';
import type { UserWithPreferences } from '@/lib/queries/settings';

interface ProfileSettingsProps {
  user: UserWithPreferences;
}

export function ProfileSettings({ user }: ProfileSettingsProps) {
  const [isPending, startTransition] = useTransition();
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [fullName, setFullName] = useState(user.full_name || '');

  const handleSignOut = async () => {
    setIsSigningOut(true);
    const supabase = createClient();
    await supabase.auth.signOut();
    Object.keys(localStorage)
      .filter((key) => key.startsWith('grov-'))
      .forEach((key) => localStorage.removeItem(key));
    window.location.href = '/login';
  };

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setMessage(null);

    const formData = new FormData();
    formData.set('full_name', fullName);

    startTransition(async () => {
      const result = await updateProfile(formData);
      if (result.error) {
        setMessage({ type: 'error', text: result.error });
      } else {
        setMessage({ type: 'success', text: 'Profile updated successfully' });
      }
    });
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  };

  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-border bg-bg-1 p-6">
        <h2 className="mb-6 text-lg font-medium">Profile</h2>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Avatar display */}
          <div className="flex items-center gap-4">
            {user.avatar_url ? (
              <img
                src={user.avatar_url}
                alt={user.full_name || 'User'}
                className="h-16 w-16 rounded-full"
              />
            ) : (
              <div className="flex h-16 w-16 items-center justify-center rounded-full bg-bg-2 text-xl font-medium text-text-secondary">
                {(user.full_name || user.email)?.[0]?.toUpperCase() || '?'}
              </div>
            )}
            <div>
              <p className="text-sm text-text-secondary">Profile photo from GitHub</p>
            </div>
          </div>

          {/* Full Name */}
          <div>
            <label htmlFor="full_name" className="mb-2 block text-sm text-text-secondary">
              Full Name
            </label>
            <input
              id="full_name"
              type="text"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder="Your name"
              maxLength={100}
              className="w-full rounded-md border border-border bg-bg-2 px-4 py-2 text-sm placeholder:text-text-muted focus:border-accent-400 focus:outline-none focus:ring-1 focus:ring-accent-400"
            />
          </div>

          {/* Email (read-only) */}
          <div>
            <label className="mb-2 block text-sm text-text-secondary">Email</label>
            <input
              type="email"
              value={user.email}
              disabled
              className="w-full rounded-md border border-border bg-bg-2 px-4 py-2 text-sm text-text-muted"
            />
            <p className="mt-1 text-xs text-text-muted">Email cannot be changed</p>
          </div>

          {/* Member since */}
          <div>
            <label className="mb-2 block text-sm text-text-secondary">Member since</label>
            <p className="text-sm text-text-primary">{formatDate(user.created_at)}</p>
          </div>

          {/* Message */}
          {message && (
            <div
              className={`rounded-md px-4 py-2 text-sm ${
                message.type === 'success'
                  ? 'bg-success/10 text-success'
                  : 'bg-error/10 text-error'
              }`}
            >
              {message.text}
            </div>
          )}

          {/* Submit */}
          <div className="pt-4">
            <button
              type="submit"
              disabled={isPending || fullName === user.full_name}
              className="rounded-md bg-accent-400 px-4 py-2 text-sm font-medium text-bg-0 transition-colors hover:bg-accent-500 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isPending ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        </form>
      </div>

      <div className="rounded-lg border border-border bg-bg-1 p-6">
        <h2 className="mb-2 text-lg font-medium">Session</h2>
        <p className="mb-4 text-sm text-text-secondary">
          Sign out of your account on this device.
        </p>
        <button
          onClick={handleSignOut}
          disabled={isSigningOut}
          className="flex items-center gap-2 rounded-md border border-border px-4 py-2 text-sm font-medium text-text-secondary transition-colors hover:bg-bg-2 hover:text-text-primary disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <LogOut className="h-4 w-4" />
          {isSigningOut ? 'Signing out...' : 'Sign out'}
        </button>
      </div>
    </div>
  );
}
