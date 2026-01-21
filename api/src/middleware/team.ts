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
  active_branch: string;
}

// Extend FastifyRequest to include team membership
declare module 'fastify' {
  interface FastifyRequest {
    teamMembership?: TeamMemberInfo;
  }
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
    .select('team_id, user_id, role, active_branch')
    .eq('team_id', teamId)
    .eq('user_id', userId)
    .single();

  if (error || !data) {
    return null;
  }

  return data as TeamMemberInfo;
}

/**
 * Extract and validate user and team ID from request.
 * Returns membership if valid, or sends error response and returns null.
 */
async function validateTeamRequest(
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
): Promise<TeamMemberInfo | null> {
  const user = request.user;

  if (!user) {
    reply.status(401).send({ error: 'Unauthorized', message: 'Authentication required' });
    return null;
  }

  const teamId = request.params.id;
  if (!teamId) {
    reply.status(400).send({ error: 'Bad Request', message: 'Team ID is required' });
    return null;
  }

  const membership = await getTeamMembership(user.id, teamId);
  if (!membership) {
    reply.status(403).send({ error: 'Forbidden', message: 'You are not a member of this team' });
    return null;
  }

  return membership;
}

/**
 * Middleware: Require team membership
 * Expects team ID in route params as :id
 * Use after requireAuth middleware
 */
export async function requireTeamMember(
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
): Promise<void> {
  const membership = await validateTeamRequest(request, reply);
  if (membership) {
    request.teamMembership = membership;
  }
}

/**
 * Middleware: Require team admin or owner role
 * Use after requireAuth middleware
 */
export async function requireTeamAdmin(
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
): Promise<void> {
  const membership = await validateTeamRequest(request, reply);
  if (!membership) return;

  if (membership.role !== 'owner' && membership.role !== 'admin') {
    return reply.status(403).send({
      error: 'Forbidden',
      message: 'Admin or owner role required for this action',
    });
  }

  request.teamMembership = membership;
}

/**
 * Middleware: Require team owner role
 * Use after requireAuth middleware
 */
export async function requireTeamOwner(
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
): Promise<void> {
  const membership = await validateTeamRequest(request, reply);
  if (!membership) return;

  if (membership.role !== 'owner') {
    return reply.status(403).send({
      error: 'Forbidden',
      message: 'Only the team owner can perform this action',
    });
  }

  request.teamMembership = membership;
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
