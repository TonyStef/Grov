/**
 * Team utilities - member limits and role checking
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { TeamRole } from '../types/team.js';

export const INVITE_EXPIRY_DAYS = 7;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function getInviteExpiryDate(): Date {
  return new Date(Date.now() + INVITE_EXPIRY_DAYS * MS_PER_DAY);
}

export interface MemberLimitCheck {
  allowed: boolean;
  current: number;
  max: number;
}

export async function checkTeamMemberLimit(
  supabase: SupabaseClient,
  teamId: string
): Promise<MemberLimitCheck> {
  const [subscriptionResult, countResult] = await Promise.all([
    supabase
      .from('subscriptions')
      .select('plan:plans(max_users)')
      .eq('team_id', teamId)
      .single(),
    supabase
      .from('team_members')
      .select('*', { count: 'exact', head: true })
      .eq('team_id', teamId),
  ]);

  const max = (subscriptionResult.data?.plan as { max_users?: number })?.max_users ?? 5;
  const current = countResult.count ?? 0;

  return { allowed: current < max, current, max };
}

export async function getTeamMemberRole(
  supabase: SupabaseClient,
  teamId: string,
  userId: string
): Promise<TeamRole | null> {
  const { data } = await supabase
    .from('team_members')
    .select('role')
    .eq('team_id', teamId)
    .eq('user_id', userId)
    .single();

  return (data?.role as TeamRole) ?? null;
}

export function isAdminOrOwner(role: TeamRole | null): boolean {
  return role === 'owner' || role === 'admin';
}
