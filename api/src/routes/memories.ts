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
 * Save chunks for a memory to the memory_chunks table
 * Handles DELETE of old chunks + INSERT of new chunks
 *
 * @param memoryId - The memory ID to associate chunks with
 * @param teamId - The team ID for the chunks
 * @param projectPath - The project path for pre-filtering
 * @param chunks - Array of MemoryChunk objects with embeddings
 * @param fastify - Fastify instance for logging
 * @returns Object with success status and counts
 */
async function saveMemoryChunks(
  memoryId: string,
  teamId: string,
  projectPath: string,
  chunks: MemoryChunk[],
  fastify: FastifyInstance
): Promise<{ success: boolean; inserted: number; error?: string }> {
  if (!chunks || chunks.length === 0) {
    return { success: true, inserted: 0 };
  }

  // Step 1: Delete existing chunks for this memory
  const { error: deleteError } = await supabase
    .from('memory_chunks')
    .delete()
    .eq('memory_id', memoryId);

  if (deleteError) {
    fastify.log.error(`[CHUNKS] Delete failed: ${deleteError.message}`);
    return { success: false, inserted: 0, error: deleteError.message };
  }

  // Step 2: Prepare chunks for insert
  const chunksToInsert = chunks.map(chunk => ({
    memory_id: memoryId,
    team_id: teamId,
    project_path: projectPath,
    chunk_type: chunk.chunk_type,
    chunk_index: chunk.chunk_index,
    content: chunk.content,
    embedding: chunk.embedding,
  }));

  // Step 3: Insert new chunks
  const { error: insertError, count } = await supabase
    .from('memory_chunks')
    .insert(chunksToInsert);

  if (insertError) {
    fastify.log.error(`[CHUNKS] Insert failed: ${insertError.message}`);
    return { success: false, inserted: 0, error: insertError.message };
  }

  return { success: true, inserted: chunks.length };
}

export default async function memoriesRoutes(fastify: FastifyInstance) {
  // List memories for a team (with optional hybrid search)
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
      } = request.query;

      const limit = Math.min(parseInt(limitStr, 10), 100);

      // HYBRID SEARCH: If context provided, use semantic search (for injection)
      // NO FALLBACK: If context is provided but search fails, return empty (strict mode)
      if (context && project_path) {
        if (!isEmbeddingEnabled()) {
          return { memories: [], cursor: null, has_more: false };
        }

        const queryEmbedding = await generateEmbedding(context);
        if (!queryEmbedding) {
          return { memories: [], cursor: null, has_more: false };
        }

        // Parse current_files (comma-separated string → array)
        const currentFilesArray = current_files
          ? current_files.split(',').map(f => f.trim()).filter(Boolean)
          : [];

        // Convert embedding array to PostgreSQL vector string format
        const embeddingStr = `[${queryEmbedding.join(',')}]`;

        // Call hybrid_search_injection RPC function (searches memory_chunks)
        const { data, error } = await supabase.rpc('hybrid_search_injection', {
          p_team_id: id,
          p_project_path: project_path,
          p_query_embedding: embeddingStr,
          p_query_text: context,
          p_current_files: currentFilesArray,
          p_limit: 5,
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

      // REGULAR QUERY: Only used when NO context provided (dashboard/listing, NOT injection)
      let query = supabase
        .from('memories')
        .select('*')
        .eq('team_id', id)
        .order('updated_at', { ascending: false })
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

      if (project_path) {
        query = query.eq('project_path', project_path);
      }

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

      if (hasMore) {
        memories.pop(); // Remove the extra item
      }

      return {
        memories,
        cursor: hasMore ? memories[memories.length - 1]?.updated_at || null : null,
        has_more: hasMore,
      };
    }
  );

  // Match endpoint - find best matching memory for UPDATE decision
  // Used by CLI before sync to check if a similar memory exists
  // POST to accept full memory data for chunk generation
  // New architecture: uses multi-vector search with chunks
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

      // Validate required params
      if (!project_path || !original_query) {
        return { match: null };
      }

      // Step 1: Generate chunks with embeddings
      const chunks = await generateChunks({
        system_name,  // Parent system anchor for semantic search
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

      // Step 2: Extract embeddings array for multi-vector search
      const embeddingsArray = chunks.map(c => `"[${c.embedding.join(',')}]"`);
      const embeddingsStr = `{${embeddingsArray.join(',')}}`;

      // Call hybrid search RPC with array of embeddings
      const { data: searchResults, error: searchError } = await supabase.rpc('hybrid_search_match', {
        p_team_id: id,
        p_project_path: project_path,
        p_query_embeddings: embeddingsStr,
        p_query_text: original_query,
        p_semantic_threshold: 0.5,  // Low base threshold, combined_score decides
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

      // Return full memory content + chunks for CLI to reuse in SYNC
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

      // Limit batch size to prevent abuse
      const MAX_MEMORIES_PER_SYNC = 100;
      if (memories.length > MAX_MEMORIES_PER_SYNC) {
        return sendError(reply, 400, `Maximum ${MAX_MEMORIES_PER_SYNC} memories per sync`);
      }

      // Separate memories into UPDATE (has memory_id) and INSERT (no memory_id)
      const memoriesToUpdate = memories.filter(m => m.memory_id);
      const memoriesToInsert = memories.filter(m => !m.memory_id);

      const embeddingsEnabled = isEmbeddingEnabled();
      let synced = 0;
      let failed = 0;
      const errors: string[] = [];

      // UPDATE PATH: memories with memory_id
      for (const memory of memoriesToUpdate) {
        try {
          // Update existing memory - CLI has already prepared all fields
          // Note: embeddings now stored in memory_chunks table, not in memories
          const { data: updatedData, error, count } = await supabase
            .from('memories')
            .update({
              // Core fields
              original_query: memory.original_query,
              goal: memory.goal,
              system_name: memory.system_name,  // Parent system anchor for semantic search
              summary: memory.summary,
              files_touched: memory.files_touched || [],
              status: memory.status,
              linked_commit: memory.linked_commit,
              // Fields prepared by CLI (shouldUpdateMemory + prepareSyncPayload)
              reasoning_trace: memory.reasoning_trace || [],
              decisions: memory.decisions || [],
              evolution_steps: memory.evolution_steps || [],
              reasoning_evolution: memory.reasoning_evolution || [],
              constraints: memory.constraints || [],
              tags: memory.tags || [],
            })
            .eq('id', memory.memory_id)
            .eq('team_id', id)  // Security: verify team ownership
            .select('id'); // Select ID to confirm update happened

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

          // Generate and save chunks for semantic search
          if (embeddingsEnabled) {
            const chunks = await generateChunks({
              system_name: memory.system_name,  // Parent system anchor for semantic search
              summary: memory.summary,
              goal: memory.goal,
              original_query: memory.original_query,
              reasoning_trace: memory.reasoning_trace,
              decisions: memory.decisions,
            });

            if (chunks && chunks.length > 0) {
              const chunkResult = await saveMemoryChunks(
                memory.memory_id!,
                id,
                memory.project_path,
                chunks,
                fastify
              );
              // Don't fail sync if chunks fail - memory is already saved
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

      // INSERT PATH: memories without memory_id
      if (memoriesToInsert.length > 0) {

        for (const memory of memoriesToInsert) {
          try {
            // Prepare memory data (without embeddings - those go in chunks now)
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

            // Generate and save chunks for semantic search
            if (embeddingsEnabled) {
              const chunks = await generateChunks({
                system_name: memory.system_name,  // Parent system anchor for semantic search
                summary: memory.summary,
                goal: memory.goal,
                original_query: memory.original_query,
                reasoning_trace: memory.reasoning_trace,
                decisions: memory.decisions,
              });

              if (chunks && chunks.length > 0) {
                const chunkResult = await saveMemoryChunks(
                  memoryId,
                  id,
                  memory.project_path,
                  chunks,
                  fastify
                );
                // Don't fail sync if chunks fail - memory is already saved
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
      }

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

  // Regenerate chunks for a memory (admin only)
  // POST /:id/memories/:memoryId/regenerate
  // New architecture: regenerates chunks in memory_chunks table
  fastify.post<{ Params: { id: string; memoryId: string } }>(
    '/:id/memories/:memoryId/regenerate',
    { preHandler: [requireAuth, requireTeamAdmin] },
    async (request, reply) => {
      const { id, memoryId } = request.params;

      // Fetch the memory
      const { data: memory, error: fetchError } = await supabase
        .from('memories')
        .select('*')
        .eq('team_id', id)
        .eq('id', memoryId)
        .single();

      if (fetchError || !memory) {
        return sendError(reply, 404, 'Memory not found');
      }


      // Generate new chunks
      const chunks = await generateChunks({
        system_name: memory.system_name,  // Parent system anchor for semantic search
        summary: memory.summary,
        goal: memory.goal,
        original_query: memory.original_query,
        reasoning_trace: memory.reasoning_trace,
        decisions: memory.decisions,
      });

      if (!chunks || chunks.length === 0) {
        return sendError(reply, 500, 'Failed to generate chunks');
      }

      // Save chunks (DELETE old + INSERT new)
      const chunkResult = await saveMemoryChunks(
        memoryId,
        id,
        memory.project_path,
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
