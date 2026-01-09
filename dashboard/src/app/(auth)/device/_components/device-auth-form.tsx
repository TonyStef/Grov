'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Lock } from 'lucide-react';

interface DeviceAuthFormProps {
  initialCode?: string;
}

export function DeviceAuthForm({ initialCode }: DeviceAuthFormProps) {
  const router = useRouter();
  const [code, setCode] = useState(initialCode || '');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [requiresLogin, setRequiresLogin] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError(null);
    setRequiresLogin(false);

    const response = await fetch('/api/auth/device/authorize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_code: code.toUpperCase() }),
    });

    if (response.status === 401) {
      setRequiresLogin(true);
      setIsLoading(false);
      return;
    }

    if (!response.ok) {
      const data = await response.json();
      setError(data.error || 'Failed to authorize device');
      setIsLoading(false);
      return;
    }

    setSuccess(true);
    setIsLoading(false);
  };

  const handleLogin = () => {
    const returnUrl = `/device${code ? `?code=${encodeURIComponent(code)}` : ''}`;
    router.push(`/login?next=${encodeURIComponent(returnUrl)}`);
  };

  if (success) {
    return (
      <div className="space-y-4 text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-success/20">
          <Check className="h-6 w-6 text-success" />
        </div>
        <p className="text-text-primary">Device authorized successfully!</p>
        <p className="text-sm text-text-secondary">
          You can close this window and return to your terminal.
        </p>
      </div>
    );
  }

  if (requiresLogin) {
    return (
      <div className="space-y-4 text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-accent-400/20">
          <Lock className="h-6 w-6 text-accent-400" />
        </div>
        <p className="text-text-primary">Sign in to authorize this device</p>
        <p className="text-sm text-text-secondary">
          Code: <span className="font-mono font-medium text-accent-400">{code}</span>
        </p>
        <button
          onClick={handleLogin}
          className="w-full rounded-md bg-accent-400 px-4 py-3 font-medium text-bg-0 transition-colors hover:bg-accent-500"
        >
          Sign in to continue
        </button>
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
