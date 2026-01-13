// Team management routes

import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  slugify,
  checkTeamMemberLimit,
  getInviteExpiryDate,
  type Team,
  type CreateTeamInput,
  type UpdateTeamInput,
  type TeamMembersResponse,
  type CreateInvitationResponse,
  type JoinTeamRequest,
} from '@grov/shared';
import { supabase } from '../db/client.js';
import { randomBytes } from 'crypto';
import { requireAuth, getAuthenticatedUser } from '../middleware/auth.js';
import { requireTeamMember, requireTeamAdmin } from '../middleware/team.js';

// Typed error response helper
function sendError(reply: FastifyReply, status: number, error: string) {
  return reply.status(status).send({ error } as Record<string, unknown>);
}

// Rate limit configurations for team endpoints
const teamRateLimits = {
  list: { max: 30, timeWindow: '1 minute' },
  read: { max: 60, timeWindow: '1 minute' },
  createTeam: { max: 5, timeWindow: '1 minute' },
  createInvite: { max: 10, timeWindow: '1 minute' },
  joinTeam: { max: 5, timeWindow: '1 minute' },
  removeMember: { max: 10, timeWindow: '1 minute' },
};

function generateInviteCode(): string {
  return randomBytes(16).toString('hex');
}

export default async function teamsRoutes(fastify: FastifyInstance) {
  // List user's teams
  fastify.get<{ Reply: { teams: Team[] } }>(
    '/',
    { preHandler: [requireAuth], config: { rateLimit: teamRateLimits.list } },
    async (request, reply) => {
      const user = getAuthenticatedUser(request);

      const { data, error } = await supabase
        .from('team_members')
        .select(`
          team:teams (
            id,
            name,
            slug,
            owner_id,
            settings,
            created_at
          )
        `)
        .eq('user_id', user.id);

      if (error) {
        fastify.log.error(error);
        return sendError(reply, 500, 'Failed to fetch teams');
      }

      const teams = (data || []).map((row) => row.team as unknown as Team);

      return { teams };
    }
  );

  // Create team
  fastify.post<{ Body: CreateTeamInput; Reply: Team }>(
    '/',
    { preHandler: [requireAuth], config: { rateLimit: teamRateLimits.createTeam } },
    async (request, reply) => {
      const user = getAuthenticatedUser(request);
      const { name, settings } = request.body;
      const slug = slugify(name);

      // Create team
      const { data: team, error: teamError } = await supabase
        .from('teams')
        .insert({
          name,
          slug,
          owner_id: user.id,
          settings: settings || {},
        })
        .select()
        .single();

      if (teamError) {
        fastify.log.error(teamError);
        if (teamError.code === '23505') {
          return sendError(reply, 409, 'Team slug already exists');
        }
        return sendError(reply, 500, 'Failed to create team');
      }

      // Add owner as member
      const { error: memberError } = await supabase.from('team_members').insert({
        team_id: team.id,
        user_id: user.id,
        role: 'owner',
      });

      if (memberError) {
        fastify.log.error(memberError);
        // Rollback: delete the team we just created
        await supabase.from('teams').delete().eq('id', team.id);
        return sendError(reply, 500, 'Failed to create team');
      }

      return team;
    }
  );

  // Get team details
  fastify.get<{ Params: { id: string }; Reply: Team }>(
    '/:id',
    { preHandler: [requireAuth, requireTeamMember], config: { rateLimit: teamRateLimits.read } },
    async (request, reply) => {
      const { id } = request.params;

      const { data, error } = await supabase
        .from('teams')
        .select('*')
        .eq('id', id)
        .single();

      if (error || !data) {
        return sendError(reply, 404, 'Team not found');
      }

      return data;
    }
  );

  // Update team
  fastify.patch<{ Params: { id: string }; Body: UpdateTeamInput; Reply: Team }>(
    '/:id',
    { preHandler: [requireAuth, requireTeamAdmin] },
    async (request, reply) => {
      const { id } = request.params;

      // Explicitly extract only allowed fields to prevent mass assignment attacks
      // This ensures attackers cannot modify protected fields like owner_id, id, or created_at
      const { name, settings } = request.body;
      const allowedUpdates: Partial<UpdateTeamInput> = {};

      if (name !== undefined) {
        allowedUpdates.name = name;
      }
      if (settings !== undefined) {
        allowedUpdates.settings = settings;
      }

      // Reject empty updates
      if (Object.keys(allowedUpdates).length === 0) {
        return sendError(reply, 400, 'No valid fields to update');
      }

      const { data, error } = await supabase
        .from('teams')
        .update(allowedUpdates)
        .eq('id', id)
        .select()
        .single();

      if (error) {
        fastify.log.error(error);
        return sendError(reply, 500, 'Failed to update team');
      }

      return data;
    }
  );

  // List team members
  fastify.get<{ Params: { id: string }; Reply: TeamMembersResponse }>(
    '/:id/members',
    { preHandler: [requireAuth, requireTeamMember], config: { rateLimit: teamRateLimits.read } },
    async (request, reply) => {
      const { id } = request.params;

      const { data, error } = await supabase
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
        .eq('team_id', id);

      if (error) {
        fastify.log.error(error);
        return sendError(reply, 500, 'Failed to fetch members');
      }

      const members = (data || []).map((item: any) => ({
        team_id: item.team_id,
        user_id: item.user_id,
        role: item.role,
        joined_at: item.joined_at,
        email: item.profile?.email || '',
        full_name: item.profile?.full_name,
        avatar_url: item.profile?.avatar_url,
      }));

      return { members };
    }
  );

  // Create invitation
  fastify.post<{ Params: { id: string }; Reply: CreateInvitationResponse }>(
    '/:id/invite',
    { preHandler: [requireAuth, requireTeamAdmin], config: { rateLimit: teamRateLimits.createInvite } },
    async (request, reply) => {
      const { id } = request.params;
      const user = getAuthenticatedUser(request);

      const limit = await checkTeamMemberLimit(supabase, id);
      if (!limit.allowed) {
        return sendError(reply, 403, 'Team member limit reached');
      }

      const inviteCode = generateInviteCode();
      const expiresAt = getInviteExpiryDate();

      const { error } = await supabase.from('team_invitations').insert({
        team_id: id,
        invite_code: inviteCode,
        created_by: user.id,
        expires_at: expiresAt.toISOString(),
      });

      if (error) {
        fastify.log.error(error);
        return sendError(reply, 500, 'Failed to create invitation');
      }

      const dashboardUrl = process.env.DASHBOARD_URL || 'http://localhost:3000';

      return {
        invite_code: inviteCode,
        expires_at: expiresAt.toISOString(),
        invite_url: `${dashboardUrl}/invite/${inviteCode}`,
      };
    }
  );

  // Join team via invite code
  fastify.post<{ Params: { code: string }; Body: JoinTeamRequest }>(
    '/join/:code',
    { preHandler: [requireAuth], config: { rateLimit: teamRateLimits.joinTeam } },
    async (request, reply) => {
      const { code } = request.params;
      const user = getAuthenticatedUser(request);

      // Find invitation
      const { data: invitation, error: inviteError } = await supabase
        .from('team_invitations')
        .select('team_id, expires_at')
        .eq('invite_code', code)
        .single();

      if (inviteError || !invitation) {
        return sendError(reply, 404, 'Invalid invite code');
      }

      if (new Date(invitation.expires_at) < new Date()) {
        return sendError(reply, 410, 'Invite code expired');
      }

      const limit = await checkTeamMemberLimit(supabase, invitation.team_id);
      if (!limit.allowed) {
        return sendError(reply, 403, 'Team member limit reached');
      }

      // Add member
      const { error: memberError } = await supabase.from('team_members').insert({
        team_id: invitation.team_id,
        user_id: user.id,
        role: 'member',
      });

      if (memberError) {
        if (memberError.code === '23505') {
          return sendError(reply, 409, 'Already a member');
        }
        fastify.log.error(memberError);
        return sendError(reply, 500, 'Failed to join team');
      }

      return { success: true, team_id: invitation.team_id };
    }
  );

  // Remove member
  fastify.delete<{ Params: { id: string; userId: string } }>(
    '/:id/members/:userId',
    { preHandler: [requireAuth, requireTeamAdmin], config: { rateLimit: teamRateLimits.removeMember } },
    async (request, reply) => {
      const { id, userId } = request.params;
      const user = getAuthenticatedUser(request);

      // Prevent removing the owner
      const { data: targetMember } = await supabase
        .from('team_members')
        .select('role')
        .eq('team_id', id)
        .eq('user_id', userId)
        .single();

      if (targetMember?.role === 'owner') {
        return sendError(reply, 403, 'Cannot remove team owner');
      }

      if (userId === user.id) {
        return sendError(reply, 400, 'Cannot remove yourself. Leave the team instead.');
      }

      const { error } = await supabase
        .from('team_members')
        .delete()
        .eq('team_id', id)
        .eq('user_id', userId);

      if (error) {
        fastify.log.error(error);
        return sendError(reply, 500, 'Failed to remove member');
      }

      return { success: true };
    }
  );
}
