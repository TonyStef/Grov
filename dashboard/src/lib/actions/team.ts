'use server';

import { cookies } from 'next/headers';
import { getAuthUser, verifyTeamMembership } from '@/lib/auth';

export async function setCurrentTeamCookie(teamId: string) {
  const user = await getAuthUser();
  if (!user) return { error: 'Unauthorized' };

  const isMember = await verifyTeamMembership(user.id, teamId);
  if (!isMember) return { error: 'Not a team member' };

  const cookieStore = await cookies();
  cookieStore.set('grov-team-id', teamId, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 365,
  });

  return { success: true };
}
