// Cursor extraction endpoint
// Tools extraction working
// POST /teams/:id/cursor/extract

import type { FastifyInstance, FastifyReply } from 'fastify';
import { supabase } from '../db/client.js';
import { requireAuth, getAuthenticatedUser } from '../middleware/auth.js';
import { requireTeamMember } from '../middleware/team.js';
import { validateCursorFormat, parseCursorRequest } from '../validators/cursor-format.js';
import {
  extractFromCursorData,
  shouldUpdateMemory,
  isHaikuAvailable,
  type ExistingMemory,
  type SessionContext,
  type ShouldUpdateResult,
  type EvolutionStep,
} from '../services/haiku-extraction.js';
import { generateChunks, isEmbeddingEnabled, type MemoryChunk } from '../lib/embeddings.js';

function sendError(reply: FastifyReply, status: number, error: string) {
  return reply.status(status).send({ error });
}

async function saveChunks(
  memoryId: string,
  teamId: string,
  projectPath: string,
  chunks: MemoryChunk[]
): Promise<void> {
  if (!chunks.length) return;

  await supabase.from('memory_chunks').delete().eq('memory_id', memoryId);

  const rows = chunks.map(c => ({
    memory_id: memoryId,
    team_id: teamId,
    project_path: projectPath,
    chunk_type: c.chunk_type,
    chunk_index: c.chunk_index,
    content: c.content,
    embedding: c.embedding,
  }));

  await supabase.from('memory_chunks').insert(rows);
}

export default async function cursorRoutes(fastify: FastifyInstance) {
  fastify.post<{ Params: { id: string } }>(
    '/:id/cursor/extract',
    {
      preHandler: [requireAuth, requireTeamMember],
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const { id: teamId } = request.params;
      const user = getAuthenticatedUser(request);

      // Validate format
      const validation = validateCursorFormat(request.body);
      if (!validation.valid) {
        console.log(`[CURSOR] Validation failed: ${validation.error}`);
        return sendError(reply, 400, validation.error || 'Invalid format');
      }

      const req = parseCursorRequest(request.body);
      console.log(`[CURSOR] Request: composerId=${req.composerId.slice(0, 8)}..., usageUuid=${req.usageUuid.slice(0, 8)}..., mode=${req.mode}, project=${req.projectPath}`);
      console.log(`[CURSOR] Content: query=${req.original_query.length} chars, text=${req.text.length} chars, thinking=${req.thinking.length} chars, tools=${req.toolCalls.length}`);

      // Skip ask mode - just acknowledge
      if (req.mode === 'ask') {
        console.log(`[CURSOR] Skipping ask mode`);
        return { success: true, action: 'skip', reason: 'ask mode' };
      }

      // Check Haiku availability
      if (!isHaikuAvailable()) {
        console.log(`[CURSOR] Haiku not available (no ANTHROPIC_API_KEY)`);
        return sendError(reply, 503, 'Extraction service unavailable');
      }

      // Extract with Haiku
      console.log(`[CURSOR] Calling Haiku extraction...`);
      const extracted = await extractFromCursorData(req);
      console.log(`[CURSOR] Haiku result: goal=${extracted.goal?.slice(0, 50) || 'null'}..., summary=${extracted.summary?.slice(0, 50) || 'null'}..., reasoning=${extracted.reasoning_trace.length}, decisions=${extracted.decisions.length}`);

      if (!extracted.goal && !extracted.summary && extracted.reasoning_trace.length === 0) {
        console.log(`[CURSOR] No extractable content, skipping`);
        return { success: true, action: 'skip', reason: 'no extractable content' };
      }

      // Search for match
      let matchedMemory: ExistingMemory | null = null;

      if (isEmbeddingEnabled() && extracted.summary) {
        console.log(`[CURSOR] Generating chunks for memory search...`);
        const chunks = await generateChunks({
          system_name: extracted.system_name,
          summary: extracted.summary,
          goal: extracted.goal || undefined,
          original_query: req.original_query,
          reasoning_trace: extracted.reasoning_trace,
          decisions: extracted.decisions,
        });

        if (chunks && chunks.length > 0) {
          console.log(`[CURSOR] Generated ${chunks.length} chunks, searching for match...`);
          const embeddingsArray = chunks.map(c => `"[${c.embedding.join(',')}]"`);
          const embeddingsStr = `{${embeddingsArray.join(',')}}`;

          const { data, error: rpcError } = await supabase.rpc('hybrid_search_match', {
            p_team_id: teamId,
            p_project_path: req.projectPath,
            p_query_embeddings: embeddingsStr,
            p_query_text: req.original_query,
            p_semantic_threshold: 0.5,
            p_limit: 1,
          });

          if (rpcError) {
            console.log(`[CURSOR] RPC error: ${rpcError.message}`);
          }

          if (data && data.length > 0) {
            // Explicitly construct with defaults for new fields
            const raw = data[0] as Record<string, unknown>;
            matchedMemory = {
              id: raw.id as string,
              goal: raw.goal as string | null,
              decisions: (raw.decisions || []) as ExistingMemory['decisions'],
              reasoning_trace: (raw.reasoning_trace || []) as ExistingMemory['reasoning_trace'],
              evolution_steps: (raw.evolution_steps || []) as EvolutionStep[],
              files_touched: (raw.files_touched || []) as string[],
              reasoning_evolution: (raw.reasoning_evolution || []) as Array<{ content: string; date: string }>,
            };
            console.log(`[CURSOR] Found matching memory: ${matchedMemory.id.slice(0, 8)}...`);
          } else {
            console.log(`[CURSOR] No matching memory found (data=${JSON.stringify(data)})`);
          }
        }
      } else {
        console.log(`[CURSOR] Embeddings disabled or no summary, skipping match search`);
      }

      // Decide action
      let action: 'insert' | 'update' | 'skip' = 'insert';
      let memoryId: string | undefined;
      let updateResult: ShouldUpdateResult | null = null;

      if (matchedMemory) {
        console.log(`[CURSOR] Calling shouldUpdateMemory...`);

        // Build SessionContext for the new signature
        const sessionContext: SessionContext = {
          task_type: extracted.task_type,
          original_query: req.original_query,
          files_touched: extracted.files_touched,
        };

        updateResult = await shouldUpdateMemory(matchedMemory, extracted, sessionContext);
        console.log(`[CURSOR] shouldUpdateMemory: ${updateResult.should_update ? 'UPDATE' : 'SKIP'} - ${updateResult.reason}`);

        if (!updateResult.should_update) {
          return { success: true, action: 'skip', reason: updateResult.reason };
        }

        action = 'update';
        memoryId = matchedMemory.id;
      }

      // Prepare memory data with full merge logic
      const now = new Date().toISOString();

      // For INSERT: simple data structure
      // For UPDATE: merge with existing data using updateResult
      let memoryData: Record<string, unknown>;

      if (action === 'update' && matchedMemory && updateResult) {
        // === MERGE LOGIC (ported from prepareSyncPayload) ===

        // 1. Handle superseded_mapping - mark old decisions as inactive
        const existingDecisions = matchedMemory.decisions || [];
        const supersededMap = new Map(
          updateResult.superseded_mapping.map(m => [m.old_index, {
            choice: m.replaced_by_choice,
            reason: m.replaced_by_reason,
            date: now,
          }])
        );

        const updatedDecisions = existingDecisions.map((d, i) => {
          const replacement = supersededMap.get(i);
          if (replacement) {
            return { ...d, active: false, superseded_by: replacement };
          }
          return { ...d, active: d.active !== false };
        });

        const newDecisions = extracted.decisions.map(d => ({
          ...d,
          date: now,
          active: true,
        }));

        const allDecisions = [...updatedDecisions, ...newDecisions];

        // 2. Handle condensed_old_reasoning - save to reasoning_evolution
        const existingReasoningEvolution = matchedMemory.reasoning_evolution || [];
        const reasoningEvolution = [...existingReasoningEvolution];
        if (updateResult.condensed_old_reasoning) {
          reasoningEvolution.push({
            content: updateResult.condensed_old_reasoning,
            date: now,
          });
        }

        // 3. Handle consolidated_evolution_steps - use if present
        const existingEvolution = matchedMemory.evolution_steps || [];
        const baseEvolution = updateResult.consolidated_evolution_steps || existingEvolution;
        const evolutionSteps = [...baseEvolution];
        if (updateResult.evolution_summary) {
          evolutionSteps.push({
            summary: updateResult.evolution_summary,
            date: now,
          });
        }

        // 4. Apply max limits
        const MAX_DECISIONS = 20;
        const MAX_EVOLUTION_STEPS = 10;
        const MAX_REASONING_EVOLUTION = 5;

        const finalDecisions = allDecisions.slice(-MAX_DECISIONS);
        const finalEvolutionSteps = evolutionSteps.slice(-MAX_EVOLUTION_STEPS);
        const finalReasoningEvolution = reasoningEvolution.slice(-MAX_REASONING_EVOLUTION);

        // 5. Build merged memory data
        memoryData = {
          team_id: teamId,
          user_id: user.id,
          project_path: req.projectPath,
          original_query: req.original_query,
          goal: extracted.goal,
          system_name: extracted.system_name,
          summary: extracted.summary,
          reasoning_trace: extracted.reasoning_trace,  // OVERWRITE with new
          decisions: finalDecisions,
          files_touched: extracted.files_touched,
          status: 'complete',
          evolution_steps: finalEvolutionSteps,
          reasoning_evolution: finalReasoningEvolution,
        };

        console.log(`[CURSOR] Merge: ${updatedDecisions.length} existing + ${newDecisions.length} new decisions, ${supersededMap.size} superseded`);
      } else {
        // INSERT: simple structure
        memoryData = {
          team_id: teamId,
          user_id: user.id,
          project_path: req.projectPath,
          original_query: req.original_query,
          goal: extracted.goal,
          system_name: extracted.system_name,
          summary: extracted.summary,
          reasoning_trace: extracted.reasoning_trace,
          decisions: extracted.decisions.map(d => ({ ...d, date: now, active: true })),
          files_touched: extracted.files_touched,
          status: 'complete',
          evolution_steps: [],
          reasoning_evolution: [],
        };
      }

      // Save
      console.log(`[CURSOR] Action: ${action}`);
      if (action === 'update' && memoryId) {
        const { error } = await supabase
          .from('memories')
          .update(memoryData)
          .eq('id', memoryId)
          .eq('team_id', teamId);

        if (error) {
          console.log(`[CURSOR] Update FAILED: ${error.message}`);
          fastify.log.error(`[CURSOR] Update failed: ${error.message}`);
          return sendError(reply, 500, 'Update failed');
        }
        console.log(`[CURSOR] Updated memory: ${memoryId.slice(0, 8)}...`);
      } else {
        const { data, error } = await supabase
          .from('memories')
          .insert(memoryData)
          .select('id')
          .single();

        if (error || !data) {
          console.log(`[CURSOR] Insert FAILED: ${error?.message}`);
          fastify.log.error(`[CURSOR] Insert failed: ${error?.message}`);
          return sendError(reply, 500, 'Insert failed');
        }

        memoryId = data.id;
        console.log(`[CURSOR] Inserted new memory: ${memoryId?.slice(0, 8)}...`);
      }

      // Generate and save chunks
      if (isEmbeddingEnabled() && memoryId) {
        const chunks = await generateChunks({
          system_name: extracted.system_name,
          summary: extracted.summary,
          goal: extracted.goal || undefined,
          original_query: req.original_query,
          reasoning_trace: extracted.reasoning_trace,
          decisions: extracted.decisions,
        });

        if (chunks) {
          await saveChunks(memoryId, teamId, req.projectPath, chunks);
          console.log(`[CURSOR] Saved ${chunks.length} chunks for memory`);
        }
      }

      console.log(`[CURSOR] Done: action=${action}, memoryId=${memoryId?.slice(0, 8)}...`);
      return { success: true, action, memoryId };
    }
  );
}

// test
