// Memory management routes

import type { FastifyInstance, FastifyReply } from 'fastify';
import type {
  Memory,
  MemoryListResponse,
  MemoryFilters,
  MemorySyncRequest,
  MemorySyncResponse,
  ReasoningTraceEntry,
} from '@grov/shared';
import { supabase } from '../db/client.js';
import { requireAuth, getAuthenticatedUser } from '../middleware/auth.js';
import { requireTeamMember, requireTeamAdmin } from '../middleware/team.js';
import {
  generateEmbedding,
  generateChunks,
  isEmbeddingEnabled,
  type MemoryChunk,
} from '../lib/embeddings.js';
import { hybridSearchMemories } from '../lib/search.js';

// Typed error response helper
function sendError(reply: FastifyReply, status: number, error: string) {
  return reply.status(status).send({ error } as Record<string, unknown>);
}

// Helper to verify branch membership for non-main branches
async function verifyBranchAccess(
  teamId: string,
  branchName: string,
  userId: string
): Promise<{ allowed: boolean; error?: string }> {
  if (branchName === 'main') {
    return { allowed: true };
  }

  // Get branch ID
  const { data: branchData, error: branchError } = await supabase
    .from('memory_branches')
    .select('id')
    .eq('team_id', teamId)
    .eq('name', branchName)
    .single();

  if (branchError || !branchData) {
    return { allowed: false, error: 'Branch not found' };
  }

  // Check membership
  const { data: membership } = await supabase
    .from('memory_branch_members')
    .select('id')
    .eq('branch_id', branchData.id)
    .eq('user_id', userId)
    .single();

  if (!membership) {
    return { allowed: false, error: 'You are not a member of this branch' };
  }

  return { allowed: true };
}

// Rate limit configurations for memory endpoints
const memoryRateLimits = {
  list: { max: 60, timeWindow: '1 minute' },
  read: { max: 60, timeWindow: '1 minute' },
  match: { max: 30, timeWindow: '1 minute' },  // For pre-sync matching
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

/**
 * Save chunks for a memory (DELETE old + INSERT new)
 */
async function saveMemoryChunks(
  memoryId: string,
  teamId: string,
  projectPath: string,
  branch: string,
  chunks: MemoryChunk[],
  fastify: FastifyInstance
): Promise<{ success: boolean; inserted: number; error?: string }> {
  if (!chunks || chunks.length === 0) {
    return { success: true, inserted: 0 };
  }

  const { error: deleteError } = await supabase
    .from('memory_chunks')
    .delete()
    .eq('memory_id', memoryId);

  if (deleteError) {
    fastify.log.error(`[CHUNKS] Delete failed: ${deleteError.message}`);
    return { success: false, inserted: 0, error: deleteError.message };
  }

  const chunksToInsert = chunks.map(chunk => ({
    memory_id: memoryId,
    team_id: teamId,
    project_path: projectPath,
    branch,
    chunk_type: chunk.chunk_type,
    chunk_index: chunk.chunk_index,
    content: chunk.content,
    embedding: chunk.embedding,
  }));

  const { error: insertError } = await supabase
    .from('memory_chunks')
    .insert(chunksToInsert);

  if (insertError) {
    fastify.log.error(`[CHUNKS] Insert failed: ${insertError.message}`);
    return { success: false, inserted: 0, error: insertError.message };
  }

  return { success: true, inserted: chunks.length };
}

export default async function memoriesRoutes(fastify: FastifyInstance) {
  // List memories for a team with optional hybrid search
  fastify.get<{
    Params: { id: string };
    Querystring: MemoryFilters & {
      limit?: string;
      cursor?: string;
      context?: string;        // User prompt for semantic search
      current_files?: string;  // Comma-separated file paths for boost
    };
    Reply: MemoryListResponse;
  }>(
    '/:id/memories',
    { preHandler: [requireAuth, requireTeamMember], config: { rateLimit: memoryRateLimits.list } },
    async (request, reply) => {
      const { id } = request.params;
      const user = getAuthenticatedUser(request);
      const {
        search,
        tags,
        files,
        from,
        to,
        status,
        user_id,
        project_path,
        limit: limitStr = '20',
        cursor,
        context,
        current_files,
        branch,
      } = request.query;

      const limit = Math.min(parseInt(limitStr, 10), 100);

      // Hybrid search for context-aware queries (used by CLI injection)
      if (context && project_path) {
        if (!isEmbeddingEnabled()) {
          return { memories: [], cursor: null, has_more: false };
        }

        const queryEmbedding = await generateEmbedding(context);
        if (!queryEmbedding) {
          return { memories: [], cursor: null, has_more: false };
        }

        const currentFilesArray = current_files
          ? current_files.split(',').map(f => f.trim()).filter(Boolean)
          : [];

        const embeddingStr = `[${queryEmbedding.join(',')}]`;

        const { data, error } = await supabase.rpc('hybrid_search_injection', {
          p_team_id: id,
          p_user_id: user.id,
          p_project_path: project_path,
          p_query_embedding: embeddingStr,
          p_query_text: context,
          p_current_files: currentFilesArray,
          p_limit: limit,
        });

        if (error) {
          fastify.log.error(`[SEARCH] RPC failed: ${error.message}`);
          return { memories: [], cursor: null, has_more: false };
        }

        return {
          memories: data || [],
          cursor: null,
          has_more: false,
        };
      }

      // Regular query for dashboard listing
      let query = supabase
        .from('memories')
        .select('*')
        .eq('team_id', id)
        .order('updated_at', { ascending: false })
        .limit(limit + 1);

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

      if (project_path) {
        query = query.eq('project_path', project_path);
      }

      // Verify branch access for non-main branches
      const targetBranch = branch || 'main';
      if (targetBranch !== 'main') {
        const branchAccess = await verifyBranchAccess(id, targetBranch, user.id);
        if (!branchAccess.allowed) {
          return sendError(reply, 403, branchAccess.error || 'Branch access denied');
        }
      }

      query = query.eq('branch', targetBranch);

      if (cursor) {
        query = query.lt('updated_at', cursor);
      }

      const { data, error } = await query;

      if (error) {
        fastify.log.error(error);
        return sendError(reply, 500, 'Failed to fetch memories');
      }

      const memories = data || [];
      const hasMore = memories.length > limit;
      if (hasMore) memories.pop();

      return {
        memories,
        cursor: hasMore && memories.length > 0 ? memories[memories.length - 1].updated_at : null,
        has_more: hasMore,
      };
    }
  );

  // Match endpoint for finding similar memories (used by CLI pre-sync)
  fastify.post<{
    Params: { id: string };
    Body: {
      project_path: string;
      summary?: string;
      goal?: string;
      system_name?: string;  // Parent system anchor for semantic search
      original_query: string;
      reasoning_trace?: ReasoningTraceEntry[];
      decisions?: Array<{ aspect?: string; tags?: string; choice: string; reason: string }>;
      evolution_steps?: Array<{ summary: string; date: string }>;
      task_type?: 'information' | 'planning' | 'implementation';
    };
    Reply: {
      match: Memory | null;
      combined_score?: number;
      // Chunks for CLI to pass to SYNC (avoid regeneration)
      chunks?: MemoryChunk[];
    };
  }>(
    '/:id/memories/match',
    { preHandler: [requireAuth, requireTeamMember], config: { rateLimit: memoryRateLimits.match } },
    async (request, reply) => {
      const { id } = request.params;
      const { project_path, summary, goal, system_name, original_query, reasoning_trace, decisions, task_type } = request.body;
      const user = getAuthenticatedUser(request);

      // Validate required params
      if (!project_path || !original_query) {
        return { match: null };
      }

      const chunks = await generateChunks({
        system_name,
        summary,
        goal,
        original_query,
        reasoning_trace: reasoning_trace || [],
        decisions: decisions || [],
      });

      if (!chunks || chunks.length === 0) {
        fastify.log.error('[MATCH] Chunk generation failed');
        return { match: null };
      }

      const embeddingsArray = chunks.map(c => `"[${c.embedding.join(',')}]"`);
      const embeddingsStr = `{${embeddingsArray.join(',')}}`;

      const { data: searchResults, error: searchError } = await supabase.rpc('hybrid_search_match', {
        p_team_id: id,
        p_user_id: user.id,
        p_project_path: project_path,
        p_query_embeddings: embeddingsStr,
        p_query_text: original_query,
        p_semantic_threshold: 0.5,
        p_limit: 1,
      });

      if (searchError) {
        fastify.log.error(`[MATCH] RPC failed: ${searchError.message}`);
        return { match: null, chunks };
      }

      if (!searchResults || searchResults.length === 0) {
        return { match: null, chunks };
      }

      const bestMatch = searchResults[0];

      return {
        match: bestMatch as unknown as Memory,
        combined_score: bestMatch.combined_score,
        chunks,
      };
    }
  );

  // Get single memory
  fastify.get<{ Params: { id: string; memoryId: string }; Reply: Memory }>(
    '/:id/memories/:memoryId',
    { preHandler: [requireAuth, requireTeamMember], config: { rateLimit: memoryRateLimits.read } },
    async (request, reply) => {
      const { id, memoryId } = request.params;
      const user = getAuthenticatedUser(request);

      const { data, error } = await supabase
        .from('memories')
        .select('*')
        .eq('team_id', id)
        .eq('id', memoryId)
        .single();

      if (error || !data) {
        return sendError(reply, 404, 'Memory not found');
      }

      // Verify branch access for non-main branches
      if (data.branch && data.branch !== 'main') {
        const branchAccess = await verifyBranchAccess(id, data.branch, user.id);
        if (!branchAccess.allowed) {
          // Return 404 to avoid leaking branch existence
          return sendError(reply, 404, 'Memory not found');
        }
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

      // Limit batch size to prevent abuse
      const MAX_MEMORIES_PER_SYNC = 100;
      if (memories.length > MAX_MEMORIES_PER_SYNC) {
        return sendError(reply, 400, `Maximum ${MAX_MEMORIES_PER_SYNC} memories per sync`);
      }

      const memoriesToUpdate = memories.filter(m => m.memory_id);
      const memoriesToInsert = memories.filter(m => !m.memory_id);

      const embeddingsEnabled = isEmbeddingEnabled();
      let synced = 0;
      let failed = 0;
      const errors: string[] = [];

      for (const memory of memoriesToUpdate) {
        try {
          // First, fetch the memory to verify branch access
          const { data: existingMemory } = await supabase
            .from('memories')
            .select('branch')
            .eq('id', memory.memory_id)
            .eq('team_id', id)
            .single();

          if (!existingMemory) {
            failed++;
            errors.push(`UPDATE ${memory.memory_id}: Memory not found`);
            continue;
          }

          // Verify branch access for non-main branches
          if (existingMemory.branch && existingMemory.branch !== 'main') {
            const branchAccess = await verifyBranchAccess(id, existingMemory.branch, user.id);
            if (!branchAccess.allowed) {
              failed++;
              errors.push(`UPDATE ${memory.memory_id}: ${branchAccess.error || 'Branch access denied'}`);
              continue;
            }
          }

          const { data: updatedData, error } = await supabase
            .from('memories')
            .update({
              original_query: memory.original_query,
              goal: memory.goal,
              system_name: memory.system_name,
              summary: memory.summary,
              files_touched: memory.files_touched || [],
              status: memory.status,
              linked_commit: memory.linked_commit,
              reasoning_trace: memory.reasoning_trace || [],
              decisions: memory.decisions || [],
              evolution_steps: memory.evolution_steps || [],
              reasoning_evolution: memory.reasoning_evolution || [],
              constraints: memory.constraints || [],
              tags: memory.tags || [],
            })
            .eq('id', memory.memory_id)
            .eq('team_id', id)
            .select('id, branch')

          if (error) {
            fastify.log.error(`[SYNC] UPDATE failed ${memory.memory_id}: ${error.message}`);
            failed++;
            errors.push(`UPDATE ${memory.memory_id}: ${error.message}`);
            continue;
          }

          if (!updatedData || updatedData.length === 0) {
            fastify.log.error(`[SYNC] UPDATE failed ${memory.memory_id}: not found`);
            failed++;
            errors.push(`UPDATE ${memory.memory_id}: ID not found or access denied`);
            continue;
          }

          if (embeddingsEnabled) {
            const chunks = await generateChunks({
              system_name: memory.system_name,
              summary: memory.summary,
              goal: memory.goal,
              original_query: memory.original_query,
              reasoning_trace: memory.reasoning_trace,
              decisions: memory.decisions,
            });

            if (chunks && chunks.length > 0) {
              const branchToUse = updatedData[0].branch || 'main';
              await saveMemoryChunks(memory.memory_id!, id, memory.project_path, branchToUse, chunks, fastify);
            }
          }

          synced++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Unknown error';
          fastify.log.error(`[SYNC] UPDATE error ${memory.memory_id}: ${msg}`);
          failed++;
          errors.push(`UPDATE ${memory.memory_id}: ${msg}`);
        }
      }

      for (const memory of memoriesToInsert) {
        try {
          const targetBranch = memory.branch || request.teamMembership?.active_branch || 'main';

          // Verify branch membership if not 'main'
          const branchAccess = await verifyBranchAccess(id, targetBranch, user.id);
          if (!branchAccess.allowed) {
            failed++;
            errors.push(`INSERT failed: ${branchAccess.error || 'Branch access denied'}`);
            continue;
          }

          const memoryData = {
              team_id: id,
              user_id: user.id,
              client_task_id: memory.client_task_id || null,
              project_path: memory.project_path,
              original_query: memory.original_query,
              goal: memory.goal,
              system_name: memory.system_name,  // Parent system anchor for semantic search
              summary: memory.summary,
              reasoning_trace: memory.reasoning_trace || [],
              files_touched: memory.files_touched || [],
              decisions: memory.decisions || [],
              constraints: memory.constraints || [],
              tags: memory.tags || [],
              status: memory.status,
              linked_commit: memory.linked_commit,
              evolution_steps: memory.evolution_steps || [],
              reasoning_evolution: memory.reasoning_evolution || [],
              branch: targetBranch,
            };

            // Insert memory and get the ID back
            const { data: insertedMemory, error: insertError } = await supabase
              .from('memories')
              .upsert(memoryData, { onConflict: 'team_id,client_task_id' })
              .select('id')
              .single();

            if (insertError || !insertedMemory) {
              fastify.log.error(`[SYNC] INSERT failed: ${insertError?.message || 'No data'}`);
              failed++;
              errors.push(`INSERT failed: ${insertError?.message || 'No data returned'}`);
              continue;
            }

            const memoryId = insertedMemory.id;

          if (embeddingsEnabled) {
            const chunks = await generateChunks({
              system_name: memory.system_name,
              summary: memory.summary,
              goal: memory.goal,
              original_query: memory.original_query,
              reasoning_trace: memory.reasoning_trace,
              decisions: memory.decisions,
            });

            if (chunks && chunks.length > 0) {
              await saveMemoryChunks(memoryId, id, memory.project_path, memoryData.branch as string, chunks, fastify);
            }
          }

          synced++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Unknown error';
          fastify.log.error(`[SYNC] INSERT error: ${msg}`);
          failed++;
          errors.push(`INSERT failed: ${msg}`);
        }
      }

      const response = {
        synced,
        failed,
        errors: errors.length > 0 ? errors : undefined,
      };

      if (failed > 0 && synced === 0) {
        return reply.status(500).send(response);
      }
      if (failed > 0) {
        return reply.status(207).send(response);
      }
      return response;
    }
  );

  // Regenerate chunks for a memory (admin only)
  fastify.post<{ Params: { id: string; memoryId: string } }>(
    '/:id/memories/:memoryId/regenerate',
    { preHandler: [requireAuth, requireTeamAdmin] },
    async (request, reply) => {
      const { id, memoryId } = request.params;

      const { data: memory, error: fetchError } = await supabase
        .from('memories')
        .select('*')
        .eq('team_id', id)
        .eq('id', memoryId)
        .single();

      if (fetchError || !memory) {
        return sendError(reply, 404, 'Memory not found');
      }

      const chunks = await generateChunks({
        system_name: memory.system_name,
        summary: memory.summary,
        goal: memory.goal,
        original_query: memory.original_query,
        reasoning_trace: memory.reasoning_trace,
        decisions: memory.decisions,
      });

      if (!chunks || chunks.length === 0) {
        return sendError(reply, 500, 'Failed to generate chunks');
      }

      const chunkResult = await saveMemoryChunks(
        memoryId,
        id,
        memory.project_path,
        memory.branch,
        chunks,
        fastify
      );

      if (!chunkResult.success) {
        fastify.log.error(`[REGEN] Failed: ${chunkResult.error}`);
        return sendError(reply, 500, 'Failed to save chunks');
      }

      return { success: true, chunks_count: chunks.length };
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

      return { success: true };
    }
  );
}
