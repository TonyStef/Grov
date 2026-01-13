import { cache } from 'react';
import { createClient } from '@/lib/supabase/server';
import type { User } from '@supabase/supabase-js';

/**
 * Get authenticated user - cached per request
 */
export const getAuthUser = cache(async (): Promise<User | null> => {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  return user;
});

interface AuthSession {
  user: User;
  accessToken: string;
}

/**
 * Get verified user and access token for API calls - cached per request
 */
export const getAuthSession = cache(async (): Promise<AuthSession | null> => {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return null;

  return { user, accessToken: session.access_token };
});

/**
 * Verify user is member of a team - cached per team per request
 */
export const verifyTeamMembership = cache(async (
  userId: string,
  teamId: string
): Promise<boolean> => {
  const supabase = await createClient();
  const { data: membership } = await supabase
    .from('team_members')
    .select('team_id')
    .eq('team_id', teamId)
    .eq('user_id', userId)
    .single();

  return !!membership;
});

/**
 * Get user's team IDs - cached per request
 */
export const getUserTeamIds = cache(async (userId: string): Promise<string[]> => {
  const supabase = await createClient();
  const { data: memberships } = await supabase
    .from('team_members')
    .select('team_id')
    .eq('user_id', userId);

  if (!memberships?.length) return [];
  return memberships.map(m => m.team_id);
});
