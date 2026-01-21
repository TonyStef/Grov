// Branch management routes
// GET /teams/:id/branches
// POST /teams/:id/branches
// PATCH /teams/:id/active-branch
// POST /teams/:id/branches/:name/merge
// POST /teams/:id/branches/:name/unmerge
// DELETE /teams/:id/branches/:name
// POST /teams/:id/branches/:name/members
// DELETE /teams/:id/branches/:name/members/:userId

import type { FastifyInstance, FastifyReply } from 'fastify';
import { supabase } from '../db/client.js';
import { requireAuth, getAuthenticatedUser } from '../middleware/auth.js';
import { requireTeamMember } from '../middleware/team.js';

// Rate limit configurations for branch endpoints
const branchRateLimits = {
  list: { max: 60, timeWindow: '1 minute' },
  create: { max: 10, timeWindow: '1 minute' },
  setActive: { max: 30, timeWindow: '1 minute' },
  merge: { max: 5, timeWindow: '1 minute' },
  unmerge: { max: 5, timeWindow: '1 minute' },
  delete: { max: 5, timeWindow: '1 minute' },
  listMembers: { max: 60, timeWindow: '1 minute' },
  addMember: { max: 20, timeWindow: '1 minute' },
  removeMember: { max: 20, timeWindow: '1 minute' },
};

// Typed error response helper
function sendError(reply: FastifyReply, status: number, error: string) {
  return reply.status(status).send({ error } as Record<string, unknown>);
}

// Helper to get branch by name with validation
async function getBranchByName(
  teamId: string,
  branchName: string,
  selectFields: string = 'id, status'
): Promise<{ id: string; status?: string; created_by?: string } | null> {
  const { data, error } = await supabase
    .from('memory_branches')
    .select(selectFields)
    .eq('team_id', teamId)
    .eq('name', branchName)
    .single();

  if (error || !data) return null;
  return data as unknown as { id: string; status?: string; created_by?: string };
}

// Helper to check branch membership
async function isBranchMember(branchId: string, userId: string): Promise<boolean> {
  const { data } = await supabase
    .from('memory_branch_members')
    .select('id')
    .eq('branch_id', branchId)
    .eq('user_id', userId)
    .single();

  return !!data;
}

export default async function branchesRoutes(fastify: FastifyInstance) {
  // List all branches user has access to
  fastify.get<{ Params: { id: string } }>(
    '/:id/branches',
    { preHandler: [requireAuth, requireTeamMember], config: { rateLimit: branchRateLimits.list } },
    async (request, reply) => {
      const { id: teamId } = request.params;
      const user = getAuthenticatedUser(request);

      const { data, error } = await supabase
        .from('memory_branches')
        .select(`
          id, name, status, created_by, created_at, merged_at, merged_by,
          members:memory_branch_members(user_id)
        `)
        .eq('team_id', teamId)
        .order('created_at', { ascending: false });

      if (error) {
        fastify.log.error(error);
        return sendError(reply, 500, 'Failed to fetch branches');
      }

      // Filter to branches where user is creator or member
      const accessibleBranches = (data || [])
        .filter(branch =>
          branch.created_by === user.id ||
          (branch.members as { user_id: string }[]).some(m => m.user_id === user.id)
        )
        .map(({ members, ...rest }) => ({
          ...rest,
          member_count: (members as { user_id: string }[]).length,
        }));

      return {
        branches: [
          { name: 'main', status: 'active', implicit: true },
          ...accessibleBranches,
        ],
      };
    }
  );

  // Create a new branch
  fastify.post<{ Params: { id: string }; Body: { name: string } }>(
    '/:id/branches',
    { preHandler: [requireAuth, requireTeamMember], config: { rateLimit: branchRateLimits.create } },
    async (request, reply) => {
      const { id: teamId } = request.params;
      const { name } = request.body;
      const user = getAuthenticatedUser(request);

      if (!name || name === 'main') {
        return sendError(reply, 400, 'Invalid branch name');
      }

      const { data, error } = await supabase
        .from('memory_branches')
        .insert({ team_id: teamId, name, created_by: user.id, status: 'active' })
        .select()
        .single();

      if (error) {
        fastify.log.error(error);
        if (error.code === '23505') {
          return sendError(reply, 409, 'Branch already exists');
        }
        return sendError(reply, 500, 'Failed to create branch');
      }

      await supabase
        .from('memory_branch_members')
        .insert({ branch_id: data.id, user_id: user.id, invited_by: user.id, role: 'admin' });

      return data;
    }
  );

  // Set current user's active branch for the team
  fastify.patch<{ Params: { id: string }; Body: { branch: string } }>(
    '/:id/active-branch',
    { preHandler: [requireAuth, requireTeamMember], config: { rateLimit: branchRateLimits.setActive } },
    async (request, reply) => {
      const { id: teamId } = request.params;
      const { branch } = request.body;
      const user = getAuthenticatedUser(request);

      if (!branch) {
        return sendError(reply, 400, 'Branch name is required');
      }

      // If not main, verify branch exists and user is a member
      if (branch !== 'main') {
        const branchData = await getBranchByName(teamId, branch, 'id');
        if (!branchData) {
          return sendError(reply, 404, 'Branch not found');
        }

        const isMember = await isBranchMember(branchData.id, user.id);
        if (!isMember) {
          return sendError(reply, 403, 'You are not a member of this branch');
        }
      }

      const { error } = await supabase
        .from('team_members')
        .update({ active_branch: branch })
        .eq('team_id', teamId)
        .eq('user_id', user.id);

      if (error) {
        fastify.log.error(error);
        return sendError(reply, 500, 'Failed to update active branch');
      }

      return { success: true, active_branch: branch };
    }
  );

  // Merge branch to main
  fastify.post<{ Params: { id: string; name: string } }>(
    '/:id/branches/:name/merge',
    { preHandler: [requireAuth, requireTeamMember], config: { rateLimit: branchRateLimits.merge } },
    async (request, reply) => {
      const { id: teamId, name: branchName } = request.params;
      const user = getAuthenticatedUser(request);

      if (branchName === 'main') {
        return sendError(reply, 400, 'Cannot merge main branch');
      }

      const branch = await getBranchByName(teamId, branchName);
      if (!branch) {
        return sendError(reply, 404, 'Branch not found');
      }

      if (branch.status === 'merged') {
        return sendError(reply, 400, 'Branch is already merged');
      }

      // Verify user is a branch admin (only admins can merge)
      const { data: memberRole } = await supabase
        .from('memory_branch_members')
        .select('role')
        .eq('branch_id', branch.id)
        .eq('user_id', user.id)
        .single();

      if (!memberRole) {
        return sendError(reply, 403, 'You are not a member of this branch');
      }

      if (memberRole.role !== 'admin') {
        return sendError(reply, 403, 'Only branch admins can merge to main');
      }

      const now = new Date().toISOString();

      // Update memories to main branch
      const { error: memError } = await supabase
        .from('memories')
        .update({ branch: 'main', source_branch: branchName, merged_at: now })
        .eq('team_id', teamId)
        .eq('branch', branchName);

      if (memError) {
        fastify.log.error(memError);
        return sendError(reply, 500, 'Failed to merge memories');
      }

      // Update chunks
      const { error: chunkError } = await supabase
        .from('memory_chunks')
        .update({ branch: 'main' })
        .eq('team_id', teamId)
        .eq('branch', branchName);

      if (chunkError) {
        fastify.log.error(chunkError);
      }

      // Mark branch as merged
      const { error: finalError } = await supabase
        .from('memory_branches')
        .update({ status: 'merged', merged_at: now, merged_by: user.id })
        .eq('id', branch.id);

      if (finalError) {
        fastify.log.error(finalError);
      }

      return { success: true };
    }
  );

  // Unmerge branch (revert)
  fastify.post<{ Params: { id: string; name: string } }>(
    '/:id/branches/:name/unmerge',
    { preHandler: [requireAuth, requireTeamMember], config: { rateLimit: branchRateLimits.unmerge } },
    async (request, reply) => {
      const { id: teamId, name: branchName } = request.params;
      const user = getAuthenticatedUser(request);

      const branch = await getBranchByName(teamId, branchName);
      if (!branch) {
        return sendError(reply, 404, 'Branch not found');
      }

      if (branch.status !== 'merged') {
        return sendError(reply, 400, 'Branch is not merged');
      }

      // Verify user is a branch admin (only admins can unmerge)
      const { data: memberRole } = await supabase
        .from('memory_branch_members')
        .select('role')
        .eq('branch_id', branch.id)
        .eq('user_id', user.id)
        .single();

      if (!memberRole) {
        return sendError(reply, 403, 'You were not a member of this branch');
      }

      if (memberRole.role !== 'admin') {
        return sendError(reply, 403, 'Only branch admins can unmerge');
      }

      // Restore memories
      const { error: memError } = await supabase
        .from('memories')
        .update({ branch: branchName, source_branch: null, merged_at: null })
        .eq('team_id', teamId)
        .eq('source_branch', branchName)
        .eq('branch', 'main');

      if (memError) {
        fastify.log.error(memError);
        return sendError(reply, 500, 'Failed to restore memories');
      }

      // Restore chunks
      const { data: memIds } = await supabase
        .from('memories')
        .select('id')
        .eq('team_id', teamId)
        .eq('branch', branchName);

      if (memIds && memIds.length > 0) {
        const { error: chunkError } = await supabase
          .from('memory_chunks')
          .update({ branch: branchName })
          .eq('team_id', teamId)
          .eq('branch', 'main')
          .in('memory_id', memIds.map(m => m.id));

        if (chunkError) {
          fastify.log.error(chunkError);
        }
      }

      // Reactivate branch
      await supabase
        .from('memory_branches')
        .update({ status: 'active', merged_at: null, merged_by: null })
        .eq('id', branch.id);

      return { success: true };
    }
  );

  // Discard branch and its memories
  fastify.delete<{ Params: { id: string; name: string } }>(
    '/:id/branches/:name',
    { preHandler: [requireAuth, requireTeamMember], config: { rateLimit: branchRateLimits.delete } },
    async (request, reply) => {
      const { id: teamId, name: branchName } = request.params;
      const user = getAuthenticatedUser(request);

      if (branchName === 'main') {
        return sendError(reply, 400, 'Cannot delete main branch');
      }

      const branch = await getBranchByName(teamId, branchName, 'id');
      if (!branch) {
        return sendError(reply, 404, 'Branch not found');
      }

      // Only current branch admin can delete the branch
      const { data: memberRole } = await supabase
        .from('memory_branch_members')
        .select('role')
        .eq('branch_id', branch.id)
        .eq('user_id', user.id)
        .single();

      if (!memberRole) {
        return sendError(reply, 403, 'You are not a member of this branch');
      }

      if (memberRole.role !== 'admin') {
        return sendError(reply, 403, 'Only branch admins can delete the branch');
      }

      // Delete in order: chunks, memories, branch
      await supabase.from('memory_chunks').delete().eq('team_id', teamId).eq('branch', branchName);
      await supabase.from('memories').delete().eq('team_id', teamId).eq('branch', branchName);
      await supabase.from('memory_branches').delete().eq('id', branch.id);

      return { success: true };
    }
  );

  // List branch members
  fastify.get<{ Params: { id: string; name: string } }>(
    '/:id/branches/:name/members',
    { preHandler: [requireAuth, requireTeamMember], config: { rateLimit: branchRateLimits.listMembers } },
    async (request, reply) => {
      const { id: teamId, name: branchName } = request.params;
      const user = getAuthenticatedUser(request);

      const branch = await getBranchByName(teamId, branchName, 'id');
      if (!branch) {
        return sendError(reply, 404, 'Branch not found');
      }

      const isMember = await isBranchMember(branch.id, user.id);
      if (!isMember) {
        return sendError(reply, 403, 'You are not a member of this branch');
      }

      const { data, error } = await supabase
        .from('memory_branch_members')
        .select(`
          user_id,
          role,
          joined_at,
          profile:profiles!memory_branch_members_user_id_fkey(email, full_name, avatar_url)
        `)
        .eq('branch_id', branch.id);

      if (error) {
        fastify.log.error(error);
        return sendError(reply, 500, 'Failed to fetch members');
      }

      const members = (data || []).map((m: any) => ({
        user_id: m.user_id,
        role: m.role,
        joined_at: m.joined_at,
        email: m.profile?.email || '',
        full_name: m.profile?.full_name,
        avatar_url: m.profile?.avatar_url,
      }));

      return { members };
    }
  );

  // Add member to branch
  fastify.post<{ Params: { id: string; name: string }; Body: { user_id: string } }>(
    '/:id/branches/:name/members',
    { preHandler: [requireAuth, requireTeamMember], config: { rateLimit: branchRateLimits.addMember } },
    async (request, reply) => {
      const { id: teamId, name: branchName } = request.params;
      const { user_id: inviteeId } = request.body;
      const user = getAuthenticatedUser(request);

      const branch = await getBranchByName(teamId, branchName, 'id');
      if (!branch) {
        return sendError(reply, 404, 'Branch not found');
      }

      // Verify user is a branch admin (only admins can invite)
      const { data: memberRole } = await supabase
        .from('memory_branch_members')
        .select('role')
        .eq('branch_id', branch.id)
        .eq('user_id', user.id)
        .single();

      if (!memberRole) {
        return sendError(reply, 403, 'You are not a member of this branch');
      }

      if (memberRole.role !== 'admin') {
        return sendError(reply, 403, 'Only branch admins can invite new members');
      }

      // Verify invitee is a team member before adding to branch
      const { data: inviteeTeamMember } = await supabase
        .from('team_members')
        .select('user_id')
        .eq('team_id', teamId)
        .eq('user_id', inviteeId)
        .single();

      if (!inviteeTeamMember) {
        return sendError(reply, 400, 'User must be a team member to be added to a branch');
      }

      const { error } = await supabase
        .from('memory_branch_members')
        .insert({ branch_id: branch.id, user_id: inviteeId, invited_by: user.id, role: 'member' });

      if (error) {
        fastify.log.error(error);
        if (error.code === '23505') {
          return sendError(reply, 409, 'User is already a member');
        }
        return sendError(reply, 500, 'Failed to add member');
      }

      return { success: true };
    }
  );

  // Remove member from branch
  fastify.delete<{ Params: { id: string; name: string; userId: string } }>(
    '/:id/branches/:name/members/:userId',
    { preHandler: [requireAuth, requireTeamMember], config: { rateLimit: branchRateLimits.removeMember } },
    async (request, reply) => {
      const { id: teamId, name: branchName, userId } = request.params;
      const user = getAuthenticatedUser(request);

      const branch = await getBranchByName(teamId, branchName, 'id');
      if (!branch) {
        return sendError(reply, 404, 'Branch not found');
      }

      // Allow removing self, or if admin
      if (userId !== user.id) {
        const { data: adminCheck } = await supabase
          .from('memory_branch_members')
          .select('role')
          .eq('branch_id', branch.id)
          .eq('user_id', user.id)
          .single();

        if (!adminCheck || adminCheck.role !== 'admin') {
          return sendError(reply, 403, 'Permission denied');
        }
      }

      const { error } = await supabase
        .from('memory_branch_members')
        .delete()
        .eq('branch_id', branch.id)
        .eq('user_id', userId);

      if (error) {
        fastify.log.error(error);
        return sendError(reply, 500, 'Failed to remove member');
      }

      return { success: true };
    }
  );
}
