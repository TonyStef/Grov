'use client';

import { useEffect } from 'react';
import { AlertCircle, RefreshCw } from 'lucide-react';

interface TeamErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function TeamError({ error, reset }: TeamErrorProps) {
  useEffect(() => {
    // Log the error to an error reporting service
    console.error('Team page error:', error);
  }, [error]);

  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] p-8">
      <div className="flex h-16 w-16 items-center justify-center rounded-full bg-error/10">
        <AlertCircle className="h-8 w-8 text-error" />
      </div>
      <h2 className="mt-6 text-xl font-semibold text-text-primary">
        Something went wrong
      </h2>
      <p className="mt-2 text-center text-text-secondary max-w-md">
        We couldn't load your team data. This might be a temporary issue.
      </p>
      {error.message && (
        <p className="mt-2 text-sm text-text-muted font-mono">
          {error.message}
        </p>
      )}
      <button
        onClick={reset}
        className="mt-6 flex items-center gap-2 rounded-md bg-accent-400 px-4 py-2 text-sm font-medium text-bg-0 transition-colors hover:bg-accent-500"
      >
        <RefreshCw className="h-4 w-4" />
        Try Again
      </button>
    </div>
  );
}
