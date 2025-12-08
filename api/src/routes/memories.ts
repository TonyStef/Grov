// Memory management routes

import type { FastifyInstance, FastifyReply } from 'fastify';
import type {
  Memory,
  MemoryListResponse,
  MemoryFilters,
  MemorySyncRequest,
  MemorySyncResponse,
} from '@grov/shared';
import { supabase } from '../db/client.js';
import { requireAuth, getAuthenticatedUser } from '../middleware/auth.js';
import { requireTeamMember, requireTeamAdmin } from '../middleware/team.js';

// Typed error response helper
function sendError(reply: FastifyReply, status: number, error: string) {
  return reply.status(status).send({ error } as Record<string, unknown>);
}

// Rate limit configurations for memory endpoints
const memoryRateLimits = {
  list: { max: 60, timeWindow: '1 minute' },
  read: { max: 60, timeWindow: '1 minute' },
  sync: { max: 20, timeWindow: '1 minute' },
  delete: { max: 10, timeWindow: '1 minute' },
};

/**
 * Sanitize search input to prevent PostgREST filter injection
 * Uses whitelist approach - only allows safe characters
 */
function sanitizeSearchInput(input: string): string {
  return input
    .replace(/[^a-zA-Z0-9\s\-_]/g, '')
    .trim()
    .substring(0, 100);
}

export default async function memoriesRoutes(fastify: FastifyInstance) {
  // List memories for a team
  fastify.get<{
    Params: { id: string };
    Querystring: MemoryFilters & { limit?: string; cursor?: string };
    Reply: MemoryListResponse;
  }>(
    '/:id/memories',
    { preHandler: [requireAuth, requireTeamMember], config: { rateLimit: memoryRateLimits.list } },
    async (request, reply) => {
      const { id } = request.params;
      const {
        search,
        tags,
        files,
        from,
        to,
        status,
        user_id,
        limit: limitStr = '20',
        cursor,
      } = request.query;

      const limit = Math.min(parseInt(limitStr, 10), 100);

      // Build query
      let query = supabase
        .from('memories')
        .select('*')
        .eq('team_id', id)
        .order('created_at', { ascending: false })
        .limit(limit + 1); // Fetch one extra to check if there are more

      // Apply filters
      if (search) {
        const sanitizedSearch = sanitizeSearchInput(search);
        query = query.or(`original_query.ilike.%${sanitizedSearch}%,goal.ilike.%${sanitizedSearch}%`);
      }

      if (tags && tags.length > 0) {
        const tagArray = Array.isArray(tags) ? tags : [tags];
        query = query.overlaps('tags', tagArray);
      }

      if (files && files.length > 0) {
        const fileArray = Array.isArray(files) ? files : [files];
        query = query.overlaps('files_touched', fileArray);
      }

      if (from) {
        query = query.gte('created_at', from);
      }

      if (to) {
        query = query.lte('created_at', to);
      }

      if (status) {
        query = query.eq('status', status);
      }

      if (user_id) {
        query = query.eq('user_id', user_id);
      }

      if (cursor) {
        query = query.lt('created_at', cursor);
      }

      const { data, error } = await query;

      if (error) {
        fastify.log.error(error);
        return sendError(reply, 500, 'Failed to fetch memories');
      }

      const memories = data || [];
      const hasMore = memories.length > limit;

      if (hasMore) {
        memories.pop(); // Remove the extra item
      }

      return {
        memories,
        cursor: hasMore ? memories[memories.length - 1]?.created_at || null : null,
        has_more: hasMore,
      };
    }
  );

  // Get single memory
  fastify.get<{ Params: { id: string; memoryId: string }; Reply: Memory }>(
    '/:id/memories/:memoryId',
    { preHandler: [requireAuth, requireTeamMember], config: { rateLimit: memoryRateLimits.read } },
    async (request, reply) => {
      const { id, memoryId } = request.params;

      const { data, error } = await supabase
        .from('memories')
        .select('*')
        .eq('team_id', id)
        .eq('id', memoryId)
        .single();

      if (error || !data) {
        return sendError(reply, 404, 'Memory not found');
      }

      return data;
    }
  );

  // Sync memories from CLI
  fastify.post<{
    Params: { id: string };
    Body: MemorySyncRequest;
    Reply: MemorySyncResponse;
  }>(
    '/:id/memories/sync',
    { preHandler: [requireAuth, requireTeamMember], config: { rateLimit: memoryRateLimits.sync } },
    async (request, reply) => {
      const { id } = request.params;
      const { memories } = request.body;
      const user = getAuthenticatedUser(request);

      if (!memories || !Array.isArray(memories)) {
        return sendError(reply, 400, 'memories array is required');
      }

      // Prepare all memories for batch upsert
      const preparedMemories = memories.map(memory => ({
        team_id: id,
        user_id: user.id,
        client_task_id: memory.client_task_id || null,
        project_path: memory.project_path,
        original_query: memory.original_query,
        goal: memory.goal,
        reasoning_trace: memory.reasoning_trace || [],
        files_touched: memory.files_touched || [],
        decisions: memory.decisions || [],
        constraints: memory.constraints || [],
        tags: memory.tags || [],
        status: memory.status,
        linked_commit: memory.linked_commit,
      }));

      let synced = 0;
      let failed = 0;
      const errors: string[] = [];

      // Batch upsert (50 records at a time for safety)
      const BATCH_SIZE = 50;
      for (let i = 0; i < preparedMemories.length; i += BATCH_SIZE) {
        const batch = preparedMemories.slice(i, i + BATCH_SIZE);
        const { error, count } = await supabase
          .from('memories')
          .upsert(batch, { onConflict: 'team_id,client_task_id', count: 'exact' });

        if (error) {
          fastify.log.error(error);
          failed += batch.length;
          errors.push(`Batch ${Math.floor(i / BATCH_SIZE) + 1} failed: ${error.message}`);
        } else {
          synced += count ?? batch.length;
        }
      }

      fastify.log.info(`Synced ${synced}/${synced + failed} memories for team ${id} by user ${user.email}`);

      const response = {
        synced,
        failed,
        errors: errors.length > 0 ? errors : undefined,
      };

      // Return appropriate status code based on results
      if (failed > 0 && synced === 0) {
        return reply.status(500).send(response);
      }
      if (failed > 0) {
        return reply.status(207).send(response);
      }
      return response;
    }
  );

  // Delete memory (admin only)
  fastify.delete<{ Params: { id: string; memoryId: string } }>(
    '/:id/memories/:memoryId',
    { preHandler: [requireAuth, requireTeamAdmin], config: { rateLimit: memoryRateLimits.delete } },
    async (request, reply) => {
      const { id, memoryId } = request.params;
      const user = getAuthenticatedUser(request);

      const { error } = await supabase
        .from('memories')
        .delete()
        .eq('team_id', id)
        .eq('id', memoryId);

      if (error) {
        fastify.log.error(error);
        return reply.status(500).send({ error: 'Failed to delete memory' });
      }

      fastify.log.info(`Deleted memory ${memoryId} from team ${id} by user ${user.email}`);

      return { success: true };
    }
  );
}
