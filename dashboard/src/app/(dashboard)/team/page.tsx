import type { Metadata } from 'next';
import { createClient } from '@/lib/supabase/server';
import {
  getUserTeams,
  getTeamMembers,
  getUserRoleInTeam,
  getTeamInvitations,
} from '@/lib/queries/teams';
import { getCurrentTeamId } from '@/lib/queries/current-team';
import { TeamPageClient } from './_components/team-page-client';

export const metadata: Metadata = {
  title: 'Team',
};

export default async function TeamPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return null;
  }

  const [teams, currentTeamId] = await Promise.all([
    getUserTeams(),
    getCurrentTeamId(),
  ]);

  if (teams.length === 0) {
    return (
      <TeamPageClient
        team={null}
        members={[]}
        invitations={[]}
        currentUserId={user.id}
        userRole={null}
      />
    );
  }

  const team = teams.find(t => t.id === currentTeamId) || teams[0];

  const [members, userRole, invitations] = await Promise.all([
    getTeamMembers(team.id),
    getUserRoleInTeam(team.id),
    getTeamInvitations(team.id),
  ]);

  return (
    <TeamPageClient
      team={team}
      members={members}
      invitations={invitations}
      currentUserId={user.id}
      userRole={userRole}
    />
  );
}
