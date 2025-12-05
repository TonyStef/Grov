import type { FastifyInstance } from 'fastify';
import type {
  Team,
  CreateTeamInput,
  UpdateTeamInput,
  TeamListResponse,
  TeamMembersResponse,
  CreateInvitationResponse,
  JoinTeamRequest,
} from '@grov/shared';
import { supabase } from '../db/client.js';
import { randomBytes } from 'crypto';

// Generate invite code
function generateInviteCode(): string {
  return randomBytes(16).toString('hex');
}

// Slugify team name
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export default async function teamsRoutes(fastify: FastifyInstance) {
  // List user's teams
  fastify.get<{ Reply: TeamListResponse }>(
    '/',
    async (request, reply) => {
      // TODO: Get user ID from auth
      const userId = 'temp-user-id';

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
        .eq('user_id', userId);

      if (error) {
        fastify.log.error(error);
        return reply.status(500).send({ error: 'Failed to fetch teams' } as any);
      }

      const teams = (data || []).map((item: any) => ({
        ...item.team,
        member_count: 1, // TODO: Add actual count
      }));

      return { teams };
    }
  );

  // Create team
  fastify.post<{ Body: CreateTeamInput; Reply: Team }>(
    '/',
    async (request, reply) => {
      const { name, settings } = request.body;
      const slug = slugify(name);

      // TODO: Get user ID from auth
      const userId = 'temp-user-id';

      // Create team
      const { data: team, error: teamError } = await supabase
        .from('teams')
        .insert({
          name,
          slug,
          owner_id: userId,
          settings: settings || {},
        })
        .select()
        .single();

      if (teamError) {
        fastify.log.error(teamError);
        if (teamError.code === '23505') {
          return reply.status(409).send({ error: 'Team slug already exists' } as any);
        }
        return reply.status(500).send({ error: 'Failed to create team' } as any);
      }

      // Add owner as member
      await supabase.from('team_members').insert({
        team_id: team.id,
        user_id: userId,
        role: 'owner',
      });

      return team;
    }
  );

  // Get team details
  fastify.get<{ Params: { id: string }; Reply: Team }>(
    '/:id',
    async (request, reply) => {
      const { id } = request.params;

      const { data, error } = await supabase
        .from('teams')
        .select('*')
        .eq('id', id)
        .single();

      if (error || !data) {
        return reply.status(404).send({ error: 'Team not found' } as any);
      }

      return data;
    }
  );

  // Update team
  fastify.patch<{ Params: { id: string }; Body: UpdateTeamInput; Reply: Team }>(
    '/:id',
    async (request, reply) => {
      const { id } = request.params;
      const updates = request.body;

      const { data, error } = await supabase
        .from('teams')
        .update(updates)
        .eq('id', id)
        .select()
        .single();

      if (error) {
        fastify.log.error(error);
        return reply.status(500).send({ error: 'Failed to update team' } as any);
      }

      return data;
    }
  );

  // List team members
  fastify.get<{ Params: { id: string }; Reply: TeamMembersResponse }>(
    '/:id/members',
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
        return reply.status(500).send({ error: 'Failed to fetch members' } as any);
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
    async (request, reply) => {
      const { id } = request.params;
      const inviteCode = generateInviteCode();
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

      // TODO: Get user ID from auth
      const userId = 'temp-user-id';

      const { error } = await supabase.from('team_invitations').insert({
        team_id: id,
        invite_code: inviteCode,
        created_by: userId,
        expires_at: expiresAt.toISOString(),
      });

      if (error) {
        fastify.log.error(error);
        return reply.status(500).send({ error: 'Failed to create invitation' } as any);
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
    async (request, reply) => {
      const { code } = request.params;

      // TODO: Get user ID from auth
      const userId = 'temp-user-id';

      // Find invitation
      const { data: invitation, error: inviteError } = await supabase
        .from('team_invitations')
        .select('team_id, expires_at')
        .eq('invite_code', code)
        .single();

      if (inviteError || !invitation) {
        return reply.status(404).send({ error: 'Invalid invite code' });
      }

      if (new Date(invitation.expires_at) < new Date()) {
        return reply.status(410).send({ error: 'Invite code expired' });
      }

      // Add member
      const { error: memberError } = await supabase.from('team_members').insert({
        team_id: invitation.team_id,
        user_id: userId,
        role: 'member',
      });

      if (memberError) {
        if (memberError.code === '23505') {
          return reply.status(409).send({ error: 'Already a member' });
        }
        fastify.log.error(memberError);
        return reply.status(500).send({ error: 'Failed to join team' });
      }

      return { success: true, team_id: invitation.team_id };
    }
  );

  // Remove member
  fastify.delete<{ Params: { id: string; userId: string } }>(
    '/:id/members/:userId',
    async (request, reply) => {
      const { id, userId } = request.params;

      // TODO: Check permissions

      const { error } = await supabase
        .from('team_members')
        .delete()
        .eq('team_id', id)
        .eq('user_id', userId);

      if (error) {
        fastify.log.error(error);
        return reply.status(500).send({ error: 'Failed to remove member' });
      }

      return { success: true };
    }
  );
}
