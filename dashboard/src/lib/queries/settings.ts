import { createClient } from '@/lib/supabase/server';
import { getAuthUser, verifyTeamMembership } from '@/lib/auth';
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
 */
export async function getUserWithPreferences(): Promise<UserWithPreferences | null> {
  const user = await getAuthUser();

  if (!user) return null;

  const supabase = await createClient();
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

  if (!team) return null;

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
  const user = await getAuthUser();

  if (!user) return false;

  const supabase = await createClient();
  const { data: membership } = await supabase
    .from('team_members')
    .select('role')
    .eq('team_id', teamId)
    .eq('user_id', user.id)
    .single();

  return membership?.role === 'owner' || membership?.role === 'admin';
}
