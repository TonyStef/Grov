'use client';

import { useState } from 'react';

interface DeviceAuthFormProps {
  initialCode?: string;
}

export function DeviceAuthForm({ initialCode }: DeviceAuthFormProps) {
  const [code, setCode] = useState(initialCode || '');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError(null);

    try {
      // TODO: Call API to authorize device
      const response = await fetch('/api/auth/device/authorize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_code: code.toUpperCase() }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to authorize device');
      }

      setSuccess(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setIsLoading(false);
    }
  };

  if (success) {
    return (
      <div className="space-y-4 text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-success/20">
          <CheckIcon className="h-6 w-6 text-success" />
        </div>
        <p className="text-text-primary">Device authorized successfully!</p>
        <p className="text-sm text-text-secondary">
          You can close this window and return to your terminal.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {error && (
        <div className="rounded-md border border-error/50 bg-error/10 p-3 text-sm text-error">
          {error}
        </div>
      )}

      <div>
        <label htmlFor="code" className="mb-2 block text-sm text-text-secondary">
          Device Code
        </label>
        <input
          id="code"
          type="text"
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          placeholder="XXXX-XXXX"
          maxLength={9}
          className="w-full rounded-md border border-border bg-bg-2 px-4 py-3 text-center font-mono text-xl tracking-widest placeholder:text-text-muted focus:border-accent-400 focus:outline-none focus:ring-1 focus:ring-accent-400"
          autoFocus
        />
      </div>

      <button
        type="submit"
        disabled={isLoading || code.length < 8}
        className="w-full rounded-md bg-accent-400 px-4 py-3 font-medium text-bg-0 transition-colors hover:bg-accent-500 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {isLoading ? 'Authorizing...' : 'Authorize Device'}
      </button>
    </form>
  );
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth={2}
      stroke="currentColor"
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
    </svg>
  );
}
