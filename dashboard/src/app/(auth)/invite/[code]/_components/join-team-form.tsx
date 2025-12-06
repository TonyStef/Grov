'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { joinTeam } from '@/app/(dashboard)/team/actions';

interface Props {
  inviteCode: string;
}

export function JoinTeamForm({ inviteCode }: Props) {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleJoin = async () => {
    setIsLoading(true);
    setError(null);

    const result = await joinTeam(inviteCode);

    if (result.error) {
      setError(result.error);
      setIsLoading(false);
    } else {
      router.push('/team');
    }
  };

  return (
    <div className="mt-4 space-y-4">
      {error && (
        <p className="text-sm text-error">{error}</p>
      )}
      <button
        onClick={handleJoin}
        disabled={isLoading}
        className="inline-flex items-center gap-2 rounded-md bg-accent-400 px-4 py-2 text-sm font-medium text-bg-0 hover:bg-accent-500 disabled:opacity-50"
      >
        {isLoading && <Loader2 className="h-4 w-4 animate-spin" />}
        Join Team
      </button>
    </div>
  );
}
