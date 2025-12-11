import { cache } from 'react';
import { createClient } from '@/lib/supabase/server';
import { getAuthUser, verifyTeamMembership } from '@/lib/auth';
import type { Team, TeamMember, TeamRole } from '@grov/shared';

export interface TeamWithMemberCount extends Team {
  member_count: number;
}

export interface TeamMemberWithProfile extends TeamMember {
  email: string;
  full_name: string | null;
  avatar_url: string | null;
}

interface ProfileData {
  email: string;
  full_name: string | null;
  avatar_url: string | null;
}

interface TeamMemberQueryResult {
  team_id: string;
  user_id: string;
  role: TeamRole;
  joined_at: string;
  profile: ProfileData | ProfileData[] | null;
}

interface TeamInvitationQueryResult {
  id: string;
  invite_code: string;
  expires_at: string;
  created_at: string;
  created_by: string;
  creator: Array<{
    email: string;
    full_name: string | null;
  }> | null;
}

/**
 * Get all teams the current user is a member of
 */
export const getUserTeams = cache(async (): Promise<TeamWithMemberCount[]> => {
  const user = await getAuthUser();

  if (!user) return [];

  const supabase = await createClient();

  const { data: memberships, error: membershipError } = await supabase
    .from('team_members')
    .select('team_id')
    .eq('user_id', user.id);

  if (membershipError || !memberships?.length) return [];

  const teamIds = memberships.map(m => m.team_id);

  const { data: teams, error: teamsError } = await supabase
    .from('teams')
    .select('*')
    .in('id', teamIds);

  if (teamsError || !teams) return [];

  const { data: allMembers } = await supabase
    .from('team_members')
    .select('team_id')
    .in('team_id', teamIds);

  const countMap = new Map<string, number>();
  allMembers?.forEach(m => {
    countMap.set(m.team_id, (countMap.get(m.team_id) || 0) + 1);
  });

  return teams.map(team => ({
    ...team,
    member_count: countMap.get(team.id) || 0,
  }));
});

/**
 * Get team by ID (if user is a member)
 */
export async function getTeam(teamId: string): Promise<Team | null> {
  const user = await getAuthUser();

  if (!user) return null;

  const isMember = await verifyTeamMembership(user.id, teamId);
  if (!isMember) return null;

  const supabase = await createClient();
  const { data: team } = await supabase
    .from('teams')
    .select('*')
    .eq('id', teamId)
    .single();

  return team;
}

/**
 * Get all members of a team (with profile info)
 */
export async function getTeamMembers(teamId: string): Promise<TeamMemberWithProfile[]> {
  const user = await getAuthUser();

  if (!user) return [];

  const isMember = await verifyTeamMembership(user.id, teamId);
  if (!isMember) return [];

  const supabase = await createClient();
  const { data: members, error } = await supabase
    .from('team_members')
    .select(`
      team_id,
      user_id,
      role,
      joined_at,
      profile:profiles (
        email,
        full_name,
        avatar_url
      )
    `)
    .eq('team_id', teamId)
    .order('joined_at', { ascending: true });

  if (error || !members) return [];

  return (members as TeamMemberQueryResult[]).map((member) => {
    const profile = Array.isArray(member.profile) ? member.profile[0] : member.profile;
    return {
      team_id: member.team_id,
      user_id: member.user_id,
      role: member.role,
      joined_at: member.joined_at,
      email: profile?.email || '',
      full_name: profile?.full_name || null,
      avatar_url: profile?.avatar_url || null,
    };
  });
}

/**
 * Get current user's role in a team
 */
export async function getUserRoleInTeam(teamId: string): Promise<string | null> {
  const user = await getAuthUser();

  if (!user) return null;

  const supabase = await createClient();
  const { data: membership } = await supabase
    .from('team_members')
    .select('role')
    .eq('team_id', teamId)
    .eq('user_id', user.id)
    .single();

  return membership?.role || null;
}

/**
 * Get pending invitations for a team
 */
export async function getTeamInvitations(teamId: string) {
  const user = await getAuthUser();

  if (!user) return [];

  const role = await getUserRoleInTeam(teamId);
  if (!role || !['owner', 'admin'].includes(role)) return [];

  const supabase = await createClient();
  const { data: invitations } = await supabase
    .from('team_invitations')
    .select(`
      id,
      invite_code,
      expires_at,
      created_at,
      created_by,
      creator:profiles!created_by (
        email,
        full_name
      )
    `)
    .eq('team_id', teamId)
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false });

  if (!invitations) return [];

  return (invitations as TeamInvitationQueryResult[]).map((inv) => ({
    id: inv.id,
    invite_code: inv.invite_code,
    expires_at: inv.expires_at,
    created_at: inv.created_at,
    creator: inv.creator?.[0] || undefined,
  }));
}
