import { createClient } from '@/lib/supabase/server';
import type { Team, TeamSettings } from '@grov/shared';

export interface UserWithPreferences {
  id: string;
  email: string;
  full_name: string | null;
  avatar_url: string | null;
  created_at: string;
  preferences: UserPreferences;
}

export interface UserPreferences {
  theme: 'dark' | 'light' | 'system';
  default_team_id: string | null;
  notifications_enabled: boolean;
  email_digest: boolean;
}

export interface TeamWithSettings extends Team {
  settings: TeamSettings;
}

const DEFAULT_PREFERENCES: UserPreferences = {
  theme: 'dark',
  default_team_id: null,
  notifications_enabled: true,
  email_digest: false,
};

const DEFAULT_TEAM_SETTINGS: TeamSettings = {
  default_tags: [],
  auto_sync: true,
  retention_days: 90,
};

/**
 * Get current user with preferences
 * Note: preferences are stored in localStorage for now (no DB column yet)
 */
export async function getUserWithPreferences(): Promise<UserWithPreferences | null> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) return null;

  const { data: profile } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .single();

  if (!profile) {
    return {
      id: user.id,
      email: user.email || '',
      full_name: user.user_metadata?.full_name || null,
      avatar_url: user.user_metadata?.avatar_url || null,
      created_at: user.created_at,
      preferences: DEFAULT_PREFERENCES,
    };
  }

  // For now, preferences come from the profile if it exists, otherwise defaults
  // Once we add the preferences column, we'll read from profile.preferences
  return {
    id: profile.id,
    email: profile.email,
    full_name: profile.full_name,
    avatar_url: profile.avatar_url,
    created_at: profile.created_at,
    preferences: DEFAULT_PREFERENCES,
  };
}

/**
 * Get team with settings
 */
export async function getTeamWithSettings(teamId: string): Promise<TeamWithSettings | null> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) return null;

  // Verify membership
  const { data: membership } = await supabase
    .from('team_members')
    .select('role')
    .eq('team_id', teamId)
    .eq('user_id', user.id)
    .single();

  if (!membership) return null;

  // Get team with settings
  const { data: team } = await supabase
    .from('teams')
    .select('*')
    .eq('id', teamId)
    .single();

  if (!team) return null;

  // Merge with defaults for any missing settings
  const settings: TeamSettings = {
    ...DEFAULT_TEAM_SETTINGS,
    ...(team.settings || {}),
  };

  return {
    ...team,
    settings,
  };
}

/**
 * Check if user is admin/owner of a team
 */
export async function isTeamAdmin(teamId: string): Promise<boolean> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) return false;

  const { data: membership } = await supabase
    .from('team_members')
    .select('role')
    .eq('team_id', teamId)
    .eq('user_id', user.id)
    .single();

  return membership?.role === 'owner' || membership?.role === 'admin';
}
