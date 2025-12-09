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
