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
        return sendError(reply, 400, validation.error || 'Invalid format');
      }

      const req = parseCursorRequest(request.body);

      // Skip ask mode - just acknowledge
      if (req.mode === 'ask') {
        return { success: true, action: 'skip', reason: 'ask mode' };
      }

      // Check Haiku availability
      if (!isHaikuAvailable()) {
        console.log(`[CURSOR] Haiku not available (no ANTHROPIC_API_KEY)`);
        return sendError(reply, 503, 'Extraction service unavailable');
      }

      // Extract with Haiku
      const extracted = await extractFromCursorData(req);

      if (!extracted.goal && !extracted.summary && extracted.reasoning_trace.length === 0) {
        return { success: true, action: 'skip', reason: 'no extractable content' };
      }

      // Search for match
      let matchedMemory: ExistingMemory | null = null;

      if (isEmbeddingEnabled() && extracted.summary) {
        const chunks = await generateChunks({
          system_name: extracted.system_name,
          summary: extracted.summary,
          goal: extracted.goal || undefined,
          original_query: req.original_query,
          reasoning_trace: extracted.reasoning_trace,
          decisions: extracted.decisions,
        });

        if (chunks && chunks.length > 0) {
          const embeddingsArray = chunks.map(c => `"[${c.embedding.join(',')}]"`);
          const embeddingsStr = `{${embeddingsArray.join(',')}}`;

          const { data, error: rpcError } = await supabase.rpc('hybrid_search_match', {
            p_team_id: teamId,
            p_user_id: user.id,
            p_project_path: req.projectPath,
            p_query_embeddings: embeddingsStr,
            p_query_text: req.original_query,
            p_semantic_threshold: 0.5,
            p_limit: 1,
          });

          if (rpcError) {
            fastify.log.error(`[CURSOR] RPC error: ${rpcError.message}`);
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
          }
        }
      }

      // Decide action
      let action: 'insert' | 'update' | 'skip' = 'insert';
      let memoryId: string | undefined;
      let updateResult: ShouldUpdateResult | null = null;

      if (matchedMemory) {
        // Build SessionContext for the new signature
        const sessionContext: SessionContext = {
          task_type: extracted.task_type,
          original_query: req.original_query,
          files_touched: extracted.files_touched,
        };

        updateResult = await shouldUpdateMemory(matchedMemory, extracted, sessionContext);

        if (!updateResult.should_update) {
          return { success: true, action: 'skip', reason: updateResult.reason };
        }

        action = 'update';
        memoryId = matchedMemory.id;
      }

      const now = new Date().toISOString();
      let memoryData: Record<string, unknown>;

      if (action === 'update' && matchedMemory && updateResult) {
        // Merge decisions with superseded mapping
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

        const newDecisions = extracted.decisions.map(d => ({ ...d, date: now, active: true }));
        const allDecisions = [...updatedDecisions, ...newDecisions];

        // Build reasoning evolution
        const reasoningEvolution = [...(matchedMemory.reasoning_evolution || [])];
        if (updateResult.condensed_old_reasoning) {
          reasoningEvolution.push({ content: updateResult.condensed_old_reasoning, date: now });
        }

        // Build evolution steps
        const baseEvolution = updateResult.consolidated_evolution_steps || matchedMemory.evolution_steps || [];
        const evolutionSteps = [...baseEvolution];
        if (updateResult.evolution_summary) {
          evolutionSteps.push({ summary: updateResult.evolution_summary, date: now });
        }

        // Apply max limits
        const MAX_DECISIONS = 20;
        const MAX_EVOLUTION_STEPS = 10;
        const MAX_REASONING_EVOLUTION = 5;

        memoryData = {
          team_id: teamId,
          user_id: user.id,
          project_path: req.projectPath,
          original_query: req.original_query,
          goal: extracted.goal,
          system_name: extracted.system_name,
          summary: extracted.summary,
          reasoning_trace: extracted.reasoning_trace,
          decisions: allDecisions.slice(-MAX_DECISIONS),
          files_touched: extracted.files_touched,
          status: 'complete',
          evolution_steps: evolutionSteps.slice(-MAX_EVOLUTION_STEPS),
          reasoning_evolution: reasoningEvolution.slice(-MAX_REASONING_EVOLUTION),
        };
      } else {
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
      if (action === 'update' && memoryId) {
        const { error } = await supabase
          .from('memories')
          .update(memoryData)
          .eq('id', memoryId)
          .eq('team_id', teamId);

        if (error) {
          fastify.log.error(`[CURSOR] Update failed: ${error.message}`);
          return sendError(reply, 500, 'Update failed');
        }
      } else {
        const { data, error } = await supabase
          .from('memories')
          .insert(memoryData)
          .select('id')
          .single();

        if (error || !data) {
          fastify.log.error(`[CURSOR] Insert failed: ${error?.message}`);
          return sendError(reply, 500, 'Insert failed');
        }

        memoryId = data.id;
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
        }
      }

      return { success: true, action, memoryId };
    }
  );
}
