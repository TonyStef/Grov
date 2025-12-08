// Team authorization middleware for Fastify
// Validates team membership and role-based access

import type { FastifyRequest, FastifyReply } from 'fastify';
import type { TeamRole } from '@grov/shared';
import { supabase } from '../db/client.js';

// Team member info from database
interface TeamMemberInfo {
  team_id: string;
  user_id: string;
  role: TeamRole;
}

/**
 * Check if user is a member of the specified team
 * @returns TeamMemberInfo if member, null otherwise
 */
async function getTeamMembership(
  userId: string,
  teamId: string
): Promise<TeamMemberInfo | null> {
  const { data, error } = await supabase
    .from('team_members')
    .select('team_id, user_id, role')
    .eq('team_id', teamId)
    .eq('user_id', userId)
    .single();

  if (error || !data) {
    return null;
  }

  return data as TeamMemberInfo;
}

/**
 * Middleware: Require team membership
 * Expects team ID in route params as :id
 * Returns 403 if user is not a member of the team
 * Use after requireAuth middleware
 */
export async function requireTeamMember(
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
): Promise<void> {
  const user = request.user;

  if (!user) {
    return reply.status(401).send({
      error: 'Unauthorized',
      message: 'Authentication required',
    });
  }

  const teamId = request.params.id;

  if (!teamId) {
    return reply.status(400).send({
      error: 'Bad Request',
      message: 'Team ID is required',
    });
  }

  // Fast path: check JWT cache first (token expires in 1hr, acceptable staleness)
  if (user.teams?.includes(teamId)) {
    return;
  }

  // Slow path: verify in database for users not in JWT cache
  const membership = await getTeamMembership(user.id, teamId);

  if (!membership) {
    return reply.status(403).send({
      error: 'Forbidden',
      message: 'You are not a member of this team',
    });
  }
}

/**
 * Middleware: Require team admin or owner role
 * Returns 403 if user is not admin/owner of the team
 * Use after requireAuth middleware
 */
export async function requireTeamAdmin(
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
): Promise<void> {
  const user = request.user;

  if (!user) {
    return reply.status(401).send({
      error: 'Unauthorized',
      message: 'Authentication required',
    });
  }

  const teamId = request.params.id;

  if (!teamId) {
    return reply.status(400).send({
      error: 'Bad Request',
      message: 'Team ID is required',
    });
  }

  // Verify team membership and role
  const membership = await getTeamMembership(user.id, teamId);

  if (!membership) {
    return reply.status(403).send({
      error: 'Forbidden',
      message: 'You are not a member of this team',
    });
  }

  if (membership.role !== 'owner' && membership.role !== 'admin') {
    return reply.status(403).send({
      error: 'Forbidden',
      message: 'Admin or owner role required for this action',
    });
  }
}

/**
 * Middleware: Require team owner role
 * Returns 403 if user is not the owner of the team
 * Use after requireAuth middleware
 */
export async function requireTeamOwner(
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
): Promise<void> {
  const user = request.user;

  if (!user) {
    return reply.status(401).send({
      error: 'Unauthorized',
      message: 'Authentication required',
    });
  }

  const teamId = request.params.id;

  if (!teamId) {
    return reply.status(400).send({
      error: 'Bad Request',
      message: 'Team ID is required',
    });
  }

  // Verify team ownership
  const membership = await getTeamMembership(user.id, teamId);

  if (!membership || membership.role !== 'owner') {
    return reply.status(403).send({
      error: 'Forbidden',
      message: 'Only the team owner can perform this action',
    });
  }
}

/**
 * Helper: Get user's teams from database
 * Returns array of team IDs the user is a member of
 */
export async function getUserTeams(userId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from('team_members')
    .select('team_id')
    .eq('user_id', userId);

  if (error || !data) {
    return [];
  }

  return data.map((row) => row.team_id);
}

/**
 * Helper: Get user's role in a specific team
 * Returns role or null if not a member
 */
export async function getUserRoleInTeam(
  userId: string,
  teamId: string
): Promise<TeamRole | null> {
  const membership = await getTeamMembership(userId, teamId);
  return membership?.role || null;
}
