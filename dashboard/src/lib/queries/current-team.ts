import { cache } from 'react';
import { cookies } from 'next/headers';
import { getAuthUser, verifyTeamMembership } from '@/lib/auth';
import { getUserTeams, type TeamWithMemberCount } from './teams';

export const getCurrentTeamId = cache(async (): Promise<string | null> => {
  const user = await getAuthUser();
  if (!user) return null;

  const cookieStore = await cookies();
  const savedTeamId = cookieStore.get('grov-team-id')?.value;

  if (savedTeamId) {
    const isMember = await verifyTeamMembership(user.id, savedTeamId);
    if (isMember) return savedTeamId;
  }

  const teams = await getUserTeams();
  return teams.length > 0 ? teams[0].id : null;
});

export const getCurrentTeam = cache(async (): Promise<TeamWithMemberCount | null> => {
  const teams = await getUserTeams();
  if (teams.length === 0) return null;

  const teamId = await getCurrentTeamId();
  if (!teamId) return teams[0];

  const team = teams.find(t => t.id === teamId);
  return team || teams[0];
});
