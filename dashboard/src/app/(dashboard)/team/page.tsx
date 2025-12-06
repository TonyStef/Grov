import type { Metadata } from 'next';
import { createClient } from '@/lib/supabase/server';
import {
  getUserTeams,
  getTeamMembers,
  getUserRoleInTeam,
  getTeamInvitations,
} from '@/lib/queries/teams';
import { TeamPageClient } from './_components/team-page-client';

export const metadata: Metadata = {
  title: 'Team',
};

export default async function TeamPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return null; // Middleware should handle this
  }

  // Get user's teams
  const teams = await getUserTeams();

  // If no teams, show empty state
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

  // Use first team for now (will add team switcher later)
  const team = teams[0];

  // Fetch team data in parallel
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
