'use server';

import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';
import { randomBytes } from 'crypto';
import { slugify, checkTeamMemberLimit, getTeamMemberRole, isAdminOrOwner, getInviteExpiryDate } from '@grov/shared';

interface ActionResult<T = unknown> {
  error?: string;
  success?: boolean;
  team?: T;
  inviteUrl?: string;
  inviteCode?: string;
}

/**
 * Create a new team
 */
export async function createTeam(formData: FormData): Promise<ActionResult<{ id: string; name: string; slug: string }>> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return { error: 'You must be logged in to create a team' };
  }

  const name = formData.get('name') as string;

  if (!name || name.length < 2 || name.length > 50) {
    return { error: 'Team name must be between 2 and 50 characters' };
  }

  const slug = slugify(name);

  // Create the team
  const { data: team, error: teamError } = await supabase
    .from('teams')
    .insert({
      name,
      slug,
      owner_id: user.id,
      settings: {},
    })
    .select('id, name, slug')
    .single();

  if (teamError) {
    if (teamError.code === '23505') {
      return { error: 'A team with this name already exists' };
    }
    console.error('Team creation error:', teamError);
    return { error: 'Failed to create team. Please try again.' };
  }

  // Add the creator as owner
  const { error: memberError } = await supabase
    .from('team_members')
    .insert({
      team_id: team.id,
      user_id: user.id,
      role: 'owner',
    });

  if (memberError) {
    // Rollback team creation
    await supabase.from('teams').delete().eq('id', team.id);
    console.error('Member creation error:', memberError);
    return { error: 'Failed to create team. Please try again.' };
  }

  revalidatePath('/team');
  revalidatePath('/dashboard');

  return { success: true, team };
}

/**
 * Create an invite link for a team
 */
export async function createInvite(teamId: string): Promise<ActionResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return { error: 'You must be logged in to create invites' };
  }

  const role = await getTeamMemberRole(supabase, teamId, user.id);
  if (!isAdminOrOwner(role)) {
    return { error: 'Only admins and owners can create invites' };
  }

  const limit = await checkTeamMemberLimit(supabase, teamId);
  if (!limit.allowed) {
    return { error: 'Team member limit reached. Upgrade your plan to add more members.' };
  }

  const inviteCode = randomBytes(16).toString('hex');
  const expiresAt = getInviteExpiryDate();

  const { error } = await supabase
    .from('team_invitations')
    .insert({
      team_id: teamId,
      invite_code: inviteCode,
      created_by: user.id,
      expires_at: expiresAt.toISOString(),
    });

  if (error) {
    console.error('Invite creation error:', error);
    return { error: 'Failed to create invite. Please try again.' };
  }

  const inviteUrl = `${process.env.APP_URL!}/invite/${inviteCode}`;

  revalidatePath('/team');

  return { success: true, inviteUrl, inviteCode };
}

/**
 * Remove a member from a team
 */
export async function removeMember(teamId: string, memberId: string): Promise<ActionResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return { error: 'You must be logged in to remove members' };
  }

  const role = await getTeamMemberRole(supabase, teamId, user.id);
  if (!isAdminOrOwner(role)) {
    return { error: 'Only admins and owners can remove members' };
  }

  const targetRole = await getTeamMemberRole(supabase, teamId, memberId);
  if (!targetRole) {
    return { error: 'Member not found' };
  }

  if (targetRole === 'owner') {
    return { error: 'Cannot remove the team owner' };
  }

  if (memberId === user.id) {
    return { error: 'You cannot remove yourself from the team' };
  }

  const { error } = await supabase
    .from('team_members')
    .delete()
    .eq('team_id', teamId)
    .eq('user_id', memberId);

  if (error) {
    console.error('Remove member error:', error);
    return { error: 'Failed to remove member. Please try again.' };
  }

  revalidatePath('/team');

  return { success: true };
}

/**
 * Change a member's role
 */
export async function changeRole(
  teamId: string,
  memberId: string,
  newRole: 'admin' | 'member'
): Promise<ActionResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return { error: 'You must be logged in to change roles' };
  }

  if (!['admin', 'member'].includes(newRole)) {
    return { error: 'Invalid role' };
  }

  const role = await getTeamMemberRole(supabase, teamId, user.id);
  if (role !== 'owner') {
    return { error: 'Only owners can change member roles' };
  }

  const targetRole = await getTeamMemberRole(supabase, teamId, memberId);
  if (!targetRole) {
    return { error: 'Member not found' };
  }

  if (targetRole === 'owner') {
    return { error: 'Cannot change the owner role' };
  }

  if (memberId === user.id) {
    return { error: 'You cannot change your own role' };
  }

  const { error } = await supabase
    .from('team_members')
    .update({ role: newRole })
    .eq('team_id', teamId)
    .eq('user_id', memberId);

  if (error) {
    return { error: 'Failed to change role. Please try again.' };
  }

  revalidatePath('/team');

  return { success: true };
}

/**
 * Cancel a pending invitation
 */
export async function cancelInvite(inviteId: string): Promise<ActionResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return { error: 'You must be logged in to cancel invites' };
  }

  // Get the invite to check team
  const { data: invite } = await supabase
    .from('team_invitations')
    .select('team_id')
    .eq('id', inviteId)
    .single();

  if (!invite) {
    return { error: 'Invitation not found' };
  }

  const role = await getTeamMemberRole(supabase, invite.team_id, user.id);
  if (!isAdminOrOwner(role)) {
    return { error: 'Only admins and owners can cancel invites' };
  }

  const { error } = await supabase
    .from('team_invitations')
    .delete()
    .eq('id', inviteId);

  if (error) {
    console.error('Cancel invite error:', error);
    return { error: 'Failed to cancel invitation. Please try again.' };
  }

  revalidatePath('/team');

  return { success: true };
}

/**
 * Join a team via invite code
 */
export async function joinTeam(inviteCode: string): Promise<ActionResult<{ id: string }>> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return { error: 'You must be logged in to join a team' };
  }

  // Find the invite
  const { data: invite } = await supabase
    .from('team_invitations')
    .select('id, team_id, expires_at')
    .eq('invite_code', inviteCode)
    .single();

  if (!invite) {
    return { error: 'Invalid or expired invite code' };
  }

  // Check if expired
  if (new Date(invite.expires_at) < new Date()) {
    return { error: 'This invite has expired' };
  }

  // Check if already a member
  const { data: existingMembership } = await supabase
    .from('team_members')
    .select('team_id')
    .eq('team_id', invite.team_id)
    .eq('user_id', user.id)
    .single();

  if (existingMembership) {
    return { error: 'You are already a member of this team' };
  }

  const limit = await checkTeamMemberLimit(supabase, invite.team_id);
  if (!limit.allowed) {
    return { error: 'This team has reached its member limit' };
  }

  // Add as member
  const { error: memberError } = await supabase
    .from('team_members')
    .insert({
      team_id: invite.team_id,
      user_id: user.id,
      role: 'member',
    });

  if (memberError) {
    console.error('Join team error:', memberError);
    return { error: 'Failed to join team. Please try again.' };
  }

  // Delete the invite (single use)
  await supabase
    .from('team_invitations')
    .delete()
    .eq('id', invite.id);

  revalidatePath('/team');
  revalidatePath('/dashboard');

  return { success: true, team: { id: invite.team_id } };
}
