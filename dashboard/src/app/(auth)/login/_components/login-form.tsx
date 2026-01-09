'use client';

import { useState } from 'react';
import { Github, Loader2 } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';

interface LoginFormProps {
  redirectTo?: string;
}

export function LoginForm({ redirectTo }: LoginFormProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleGitHubLogin = async () => {
    setIsLoading(true);
    setError(null);

    try {
      const supabase = createClient();
      const callbackUrl = new URL('/auth/callback', window.location.origin);
      if (redirectTo) {
        callbackUrl.searchParams.set('next', redirectTo);
      }

      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'github',
        options: {
          redirectTo: callbackUrl.toString(),
        },
      });

      if (error) {
        setError(error.message);
        setIsLoading(false);
      }
    } catch (err) {
      setError('An unexpected error occurred');
      setIsLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      {error && (
        <div className="rounded-md border border-error/50 bg-error/10 p-3 text-sm text-error">
          {error}
        </div>
      )}

      <button
        onClick={handleGitHubLogin}
        disabled={isLoading}
        className="flex w-full items-center justify-center gap-3 rounded-md bg-bg-2 px-4 py-3 font-medium transition-colors hover:bg-bg-3 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {isLoading ? (
          <Loader2 className="h-5 w-5 animate-spin" />
        ) : (
          <>
            <Github className="h-5 w-5" />
            Continue with GitHub
          </>
        )}
      </button>
    </div>
  );
}
