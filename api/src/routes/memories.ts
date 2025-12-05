// Memory management routes
// All routes require authentication and team membership

import type { FastifyInstance } from 'fastify';
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

// Rate limit configurations for memory endpoints
const memoryRateLimits = {
  sync: { max: 20, timeWindow: '1 minute' }, // 20 sync requests per minute
};

/**
 * Sanitize search input to prevent PostgREST filter injection
 * Removes characters that have syntactic meaning in PostgREST filter expressions
 */
function sanitizeSearchInput(input: string): string {
  // Remove PostgREST special characters: . , ( ) that could break filter syntax
  // Keep % as it's useful for wildcard searching within ilike
  return input.replace(/[.,()]/g, '');
}

export default async function memoriesRoutes(fastify: FastifyInstance) {
  // List memories for a team
  fastify.get<{
    Params: { id: string };
    Querystring: MemoryFilters & { limit?: string; cursor?: string };
    Reply: MemoryListResponse;
  }>(
    '/:id/memories',
    { preHandler: [requireAuth, requireTeamMember] },
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
        return reply.status(500).send({ error: 'Failed to fetch memories' } as any);
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
    { preHandler: [requireAuth, requireTeamMember] },
    async (request, reply) => {
      const { id, memoryId } = request.params;

      const { data, error } = await supabase
        .from('memories')
        .select('*')
        .eq('team_id', id)
        .eq('id', memoryId)
        .single();

      if (error || !data) {
        return reply.status(404).send({ error: 'Memory not found' } as any);
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
        return reply.status(400).send({ error: 'memories array is required' } as any);
      }

      let synced = 0;
      let failed = 0;
      const errors: string[] = [];

      for (const memory of memories) {
        const { error } = await supabase.from('memories').insert({
          team_id: id,
          user_id: user.id,
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
        });

        if (error) {
          fastify.log.error(error);
          failed++;
          errors.push(`Failed to sync memory: ${memory.original_query?.substring(0, 50)}`);
        } else {
          synced++;
        }
      }

      fastify.log.info(`Synced ${synced} memories for team ${id} by user ${user.email}`);

      return {
        synced,
        failed,
        errors: errors.length > 0 ? errors : undefined,
      };
    }
  );

  // Delete memory (admin only)
  fastify.delete<{ Params: { id: string; memoryId: string } }>(
    '/:id/memories/:memoryId',
    { preHandler: [requireAuth, requireTeamAdmin] },
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
