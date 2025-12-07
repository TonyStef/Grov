'use server';

import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';
import type { TeamSettings } from '@grov/shared';

interface ActionResult {
  error?: string;
  success?: boolean;
}

/**
 * Update user profile (full_name)
 */
export async function updateProfile(formData: FormData): Promise<ActionResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return { error: 'You must be logged in to update your profile' };
  }

  const fullName = formData.get('full_name') as string;

  // Validate
  if (!fullName || fullName.length < 1) {
    return { error: 'Name is required' };
  }

  if (fullName.length > 100) {
    return { error: 'Name must be 100 characters or less' };
  }

  // Update profile
  const { error } = await supabase
    .from('profiles')
    .update({ full_name: fullName.trim() })
    .eq('id', user.id);

  if (error) {
    console.error('Profile update error:', error);
    return { error: 'Failed to update profile. Please try again.' };
  }

  revalidatePath('/settings');
  revalidatePath('/dashboard');

  return { success: true };
}

/**
 * Update team name
 */
export async function updateTeamName(teamId: string, name: string): Promise<ActionResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return { error: 'You must be logged in to update team settings' };
  }

  // Verify user is admin or owner
  const { data: membership } = await supabase
    .from('team_members')
    .select('role')
    .eq('team_id', teamId)
    .eq('user_id', user.id)
    .single();

  if (!membership || !['owner', 'admin'].includes(membership.role)) {
    return { error: 'Only admins and owners can update team settings' };
  }

  // Validate
  if (!name || name.length < 2) {
    return { error: 'Team name must be at least 2 characters' };
  }

  if (name.length > 50) {
    return { error: 'Team name must be 50 characters or less' };
  }

  // Generate new slug
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

  // Update team
  const { error } = await supabase
    .from('teams')
    .update({ name: name.trim(), slug })
    .eq('id', teamId);

  if (error) {
    if (error.code === '23505') {
      return { error: 'A team with this name already exists' };
    }
    console.error('Team name update error:', error);
    return { error: 'Failed to update team name. Please try again.' };
  }

  revalidatePath('/settings');
  revalidatePath('/team');
  revalidatePath('/dashboard');

  return { success: true };
}

/**
 * Update team settings (tags, auto_sync, retention_days)
 */
export async function updateTeamSettings(
  teamId: string,
  settings: Partial<TeamSettings>
): Promise<ActionResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return { error: 'You must be logged in to update team settings' };
  }

  // Verify user is admin or owner
  const { data: membership } = await supabase
    .from('team_members')
    .select('role')
    .eq('team_id', teamId)
    .eq('user_id', user.id)
    .single();

  if (!membership || !['owner', 'admin'].includes(membership.role)) {
    return { error: 'Only admins and owners can update team settings' };
  }

  // Get current settings
  const { data: team } = await supabase
    .from('teams')
    .select('settings')
    .eq('id', teamId)
    .single();

  if (!team) {
    return { error: 'Team not found' };
  }

  // Validate settings
  if (settings.retention_days !== undefined) {
    if (settings.retention_days < 1 || settings.retention_days > 365) {
      return { error: 'Retention days must be between 1 and 365' };
    }
  }

  if (settings.default_tags !== undefined) {
    // Sanitize tags
    settings.default_tags = settings.default_tags
      .map(tag => tag.trim().toLowerCase().replace(/[^a-z0-9-]/g, ''))
      .filter(tag => tag.length > 0)
      .slice(0, 10); // Max 10 tags
  }

  // Merge with existing settings
  const mergedSettings = {
    ...(team.settings || {}),
    ...settings,
  };

  // Update team settings
  const { error } = await supabase
    .from('teams')
    .update({ settings: mergedSettings })
    .eq('id', teamId);

  if (error) {
    console.error('Team settings update error:', error);
    return { error: 'Failed to update team settings. Please try again.' };
  }

  revalidatePath('/settings');
  revalidatePath('/team');

  return { success: true };
}

/**
 * Delete user account
 * Note: This is a placeholder - actual account deletion should be more careful
 */
export async function deleteAccount(): Promise<ActionResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return { error: 'You must be logged in to delete your account' };
  }

  // Check if user owns any teams
  const { data: ownedTeams } = await supabase
    .from('teams')
    .select('id, name')
    .eq('owner_id', user.id);

  if (ownedTeams && ownedTeams.length > 0) {
    return {
      error: `You must transfer ownership of your teams before deleting your account: ${ownedTeams.map(t => t.name).join(', ')}`,
    };
  }

  // Remove from all teams
  await supabase
    .from('team_members')
    .delete()
    .eq('user_id', user.id);

  // Delete profile
  await supabase
    .from('profiles')
    .delete()
    .eq('id', user.id);

  // Sign out (account deletion from auth.users requires admin API)
  await supabase.auth.signOut();

  return { success: true };
}
