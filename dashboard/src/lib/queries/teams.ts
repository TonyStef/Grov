import { createClient } from '@/lib/supabase/server';
import type { Team, TeamMember } from '@grov/shared';

export interface TeamWithMemberCount extends Team {
  member_count: number;
}

export interface TeamMemberWithProfile extends TeamMember {
  email: string;
  full_name: string | null;
  avatar_url: string | null;
}

/**
 * Get all teams the current user is a member of
 */
export async function getUserTeams(): Promise<TeamWithMemberCount[]> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) return [];

  // Get teams where user is a member
  const { data: memberships, error: membershipError } = await supabase
    .from('team_members')
    .select('team_id')
    .eq('user_id', user.id);

  if (membershipError || !memberships?.length) return [];

  const teamIds = memberships.map(m => m.team_id);

  // Get team details
  const { data: teams, error: teamsError } = await supabase
    .from('teams')
    .select('*')
    .in('id', teamIds);

  if (teamsError || !teams) return [];

  // Get member counts for each team
  const teamsWithCounts: TeamWithMemberCount[] = [];

  for (const team of teams) {
    const { count } = await supabase
      .from('team_members')
      .select('*', { count: 'exact', head: true })
      .eq('team_id', team.id);

    teamsWithCounts.push({
      ...team,
      member_count: count || 0,
    });
  }

  return teamsWithCounts;
}

/**
 * Get team by ID (if user is a member)
 */
export async function getTeam(teamId: string): Promise<Team | null> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) return null;

  // Verify membership
  const { data: membership } = await supabase
    .from('team_members')
    .select('team_id')
    .eq('team_id', teamId)
    .eq('user_id', user.id)
    .single();

  if (!membership) return null;

  // Get team
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
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) return [];

  // Verify user is a member of this team first
  const { data: membership } = await supabase
    .from('team_members')
    .select('team_id')
    .eq('team_id', teamId)
    .eq('user_id', user.id)
    .single();

  if (!membership) return [];

  // Get all members with profile data
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

  // Flatten profile data into member
  return members.map((member: any) => ({
    team_id: member.team_id,
    user_id: member.user_id,
    role: member.role,
    joined_at: member.joined_at,
    email: member.profile?.email || '',
    full_name: member.profile?.full_name || null,
    avatar_url: member.profile?.avatar_url || null,
  }));
}

/**
 * Get current user's role in a team
 */
export async function getUserRoleInTeam(teamId: string): Promise<string | null> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) return null;

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
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) return [];

  // Verify user is admin/owner
  const role = await getUserRoleInTeam(teamId);
  if (!role || !['owner', 'admin'].includes(role)) return [];

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

  // Flatten creator from array to single object (Supabase returns array for joins)
  return invitations.map((inv: any) => ({
    id: inv.id,
    invite_code: inv.invite_code,
    expires_at: inv.expires_at,
    created_at: inv.created_at,
    creator: inv.creator?.[0] || undefined,
  }));
}
