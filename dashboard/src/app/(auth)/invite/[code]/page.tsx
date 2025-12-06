import type { Metadata } from 'next';
import { createClient } from '@/lib/supabase/server';
import { JoinTeamForm } from './_components/join-team-form';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Join Team',
  description: 'Join a Grov team',
};

interface Props {
  params: Promise<{ code: string }>;
}

async function getInviteDetails(code: string): Promise<{
  id: string;
  team_id: string;
  expires_at: string;
  team_name: string;
} | null> {
  const supabase = await createClient();

  const { data: invite } = await supabase
    .from('team_invitations')
    .select('id, team_id, expires_at, teams(name)')
    .eq('invite_code', code)
    .single();

  if (!invite) return null;

  // Supabase returns joins as arrays - extract first element
  const teams = invite.teams as any;
  const teamName = Array.isArray(teams) ? teams[0]?.name : teams?.name;

  return {
    id: invite.id,
    team_id: invite.team_id,
    expires_at: invite.expires_at,
    team_name: teamName || 'Unknown Team',
  };
}

export default async function InvitePage({ params }: Props) {
  const { code } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  const invite = await getInviteDetails(code);

  if (!invite) {
    return (
      <div className="animate-fade-in space-y-6">
        <div className="text-center">
          <h1 className="font-mono text-3xl font-bold text-accent-400 text-glow">grov</h1>
        </div>
        <div className="rounded-lg border border-border bg-bg-1 p-6 shadow-md text-center">
          <h2 className="text-lg font-medium text-error">Invalid Invite</h2>
          <p className="mt-2 text-sm text-text-secondary">
            This invite link is invalid or has already been used.
          </p>
          <Link href="/login" className="mt-4 inline-block text-accent-400 hover:underline">
            Go to login
          </Link>
        </div>
      </div>
    );
  }

  const isExpired = new Date(invite.expires_at) < new Date();
  if (isExpired) {
    return (
      <div className="animate-fade-in space-y-6">
        <div className="text-center">
          <h1 className="font-mono text-3xl font-bold text-accent-400 text-glow">grov</h1>
        </div>
        <div className="rounded-lg border border-border bg-bg-1 p-6 shadow-md text-center">
          <h2 className="text-lg font-medium text-error">Invite Expired</h2>
          <p className="mt-2 text-sm text-text-secondary">
            This invite link has expired. Ask your team admin for a new one.
          </p>
          <Link href="/login" className="mt-4 inline-block text-accent-400 hover:underline">
            Go to login
          </Link>
        </div>
      </div>
    );
  }

  const teamName = invite.team_name;

  if (!user) {
    return (
      <div className="animate-fade-in space-y-6">
        <div className="text-center">
          <h1 className="font-mono text-3xl font-bold text-accent-400 text-glow">grov</h1>
        </div>
        <div className="rounded-lg border border-border bg-bg-1 p-6 shadow-md text-center">
          <h2 className="text-lg font-medium">Join {teamName}</h2>
          <p className="mt-2 text-sm text-text-secondary">
            Sign in with GitHub to join this team.
          </p>
          <Link
            href={`/login?next=/invite/${code}`}
            className="mt-4 inline-flex items-center gap-2 rounded-md bg-accent-400 px-4 py-2 text-sm font-medium text-bg-0 hover:bg-accent-500"
          >
            Sign in to join
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="animate-fade-in space-y-6">
      <div className="text-center">
        <h1 className="font-mono text-3xl font-bold text-accent-400 text-glow">grov</h1>
      </div>
      <div className="rounded-lg border border-border bg-bg-1 p-6 shadow-md text-center">
        <h2 className="text-lg font-medium">Join {teamName}</h2>
        <p className="mt-2 text-sm text-text-secondary">
          You&apos;ve been invited to join this team.
        </p>
        <JoinTeamForm inviteCode={code} />
      </div>
    </div>
  );
}
