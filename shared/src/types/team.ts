/**
 * Team types - team management and membership
 * Aligns with Supabase teams, team_members, team_invitations tables
 */

// Team member role
export type TeamRole = 'owner' | 'admin' | 'member';

// Team settings stored as JSONB
export interface TeamSettings {
  default_tags?: string[];
  auto_sync?: boolean;
  retention_days?: number;
}

// Team record
export interface Team {
  id: string;
  name: string;
  slug: string;
  owner_id: string;
  settings: TeamSettings;
  created_at: string;
}

// Team with member count (for lists)
export interface TeamWithMemberCount extends Team {
  member_count: number;
}

// Team member record
export interface TeamMember {
  team_id: string;
  user_id: string;
  role: TeamRole;
  joined_at: string;
  active_branch: string;
}

// Team member with profile info
export interface TeamMemberWithProfile extends TeamMember {
  email: string;
  full_name: string | null;
  avatar_url: string | null;
}

// Team invitation record
export interface TeamInvitation {
  id: string;
  team_id: string;
  invite_code: string;
  created_by: string;
  expires_at: string;
  created_at: string;
}

// Input for creating a team
export interface CreateTeamInput {
  name: string;
  slug: string;
  settings?: TeamSettings;
}

// Input for updating a team
export interface UpdateTeamInput {
  name?: string;
  settings?: TeamSettings;
}

// Response for team list
export interface TeamListResponse {
  teams: TeamWithMemberCount[];
}

// Response for team members list
export interface TeamMembersResponse {
  members: TeamMemberWithProfile[];
}

// Response for creating an invitation
export interface CreateInvitationResponse {
  invite_code: string;
  expires_at: string;
  invite_url: string;
}

// Request for joining a team
export interface JoinTeamRequest {
  invite_code: string;
}
