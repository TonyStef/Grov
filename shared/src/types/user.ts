/**
 * User types - user profiles and preferences
 * Aligns with Supabase profiles table
 */

// User profile record
export interface Profile {
  id: string;
  email: string;
  full_name: string | null;
  avatar_url: string | null;
  created_at: string;
}

// User preferences (stored in profile or separate table)
export interface UserPreferences {
  theme?: 'dark' | 'light' | 'system';
  default_team_id?: string;
  notifications_enabled?: boolean;
  keyboard_shortcuts_enabled?: boolean;
}

// Input for updating profile
export interface UpdateProfileInput {
  full_name?: string;
  avatar_url?: string;
}

// Current user with preferences
export interface CurrentUser extends Profile {
  preferences?: UserPreferences;
  teams?: Array<{
    id: string;
    name: string;
    slug: string;
    role: 'owner' | 'admin' | 'member';
  }>;
}
