'use client';

import { useState, useEffect } from 'react';

interface NotificationPreferences {
  email_invites: boolean;
  email_digest: boolean;
  email_mentions: boolean;
}

const STORAGE_KEY = 'grov-notification-preferences';

function loadNotificationPreferences(): NotificationPreferences {
  if (typeof window === 'undefined') {
    return { email_invites: true, email_digest: false, email_mentions: true };
  }
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      return JSON.parse(stored);
    }
  } catch {
    // Ignore parse errors
  }
  return { email_invites: true, email_digest: false, email_mentions: true };
}

function saveNotificationPreferences(prefs: NotificationPreferences) {
  if (typeof window === 'undefined') return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
}

export function NotificationsSettings() {
  const [preferences, setPreferences] = useState<NotificationPreferences>({
    email_invites: true,
    email_digest: false,
    email_mentions: true,
  });
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [mounted, setMounted] = useState(false);

  // Load from localStorage on mount
  useEffect(() => {
    setPreferences(loadNotificationPreferences());
    setMounted(true);
  }, []);

  const handleToggle = (key: keyof NotificationPreferences) => {
    const newPrefs = { ...preferences, [key]: !preferences[key] };
    setPreferences(newPrefs);
    saveNotificationPreferences(newPrefs);
    setMessage({ type: 'success', text: 'Notification preference saved' });
    setTimeout(() => setMessage(null), 2000);
  };

  if (!mounted) {
    return (
      <div className="rounded-lg border border-border bg-bg-1 p-6">
        <h2 className="mb-6 text-lg font-medium">Notifications</h2>
        <div className="animate-pulse space-y-4">
          <div className="h-12 w-full rounded bg-bg-2" />
          <div className="h-12 w-full rounded bg-bg-2" />
          <div className="h-12 w-full rounded bg-bg-2" />
        </div>
      </div>
    );
  }

  const notifications = [
    {
      key: 'email_invites' as const,
      label: 'Team Invitations',
      description: 'Get notified when you are invited to a team',
    },
    {
      key: 'email_digest' as const,
      label: 'Weekly Digest',
      description: 'Receive a weekly summary of team activity',
    },
    {
      key: 'email_mentions' as const,
      label: 'Mentions',
      description: 'Get notified when someone mentions you in a memory',
    },
  ];

  return (
    <div className="rounded-lg border border-border bg-bg-1 p-6">
      <h2 className="mb-6 text-lg font-medium">Notifications</h2>

      <div className="mb-6 rounded-md border border-accent-400/30 bg-accent-400/10 px-4 py-3">
        <p className="text-sm text-text-secondary">
          Email notifications coming soon. Preferences are saved locally for now.
        </p>
      </div>

      <div className="space-y-4">
        {notifications.map(({ key, label, description }) => (
          <div
            key={key}
            className="flex items-center justify-between rounded-md border border-border bg-bg-2 p-4"
          >
            <div>
              <p className="text-sm font-medium text-text-primary">{label}</p>
              <p className="text-xs text-text-muted">{description}</p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={preferences[key]}
              onClick={() => handleToggle(key)}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                preferences[key] ? 'bg-accent-400' : 'bg-bg-3'
              }`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  preferences[key] ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </button>
          </div>
        ))}

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
      </div>
    </div>
  );
}
