// Antigravity extraction endpoint
// POST /teams/:id/antigravity/extract

import type { FastifyInstance, FastifyReply } from 'fastify';
import { supabase } from '../db/client.js';
import { requireAuth, getAuthenticatedUser } from '../middleware/auth.js';
import { requireTeamMember } from '../middleware/team.js';
import {
  extractFromAntigravityData,
  shouldUpdateMemory,
  isHaikuAvailable,
  type ExistingMemory,
  type SessionContext,
  type ShouldUpdateResult,
  type EvolutionStep,
} from '../services/haiku-extraction.js';
import { generateChunks, isEmbeddingEnabled, type MemoryChunk } from '../lib/embeddings.js';

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

export interface AntigravityExtractRequest {
  sessionId: string;
  projectPath: string;
  linkedCommit: string | null;
  title: string;
  metadataSummary: string;
  planContent: string;
  taskContent: string;
  filesTouched: string[];
  completionStatus: 'complete' | 'partial';
  updatedAt: string;
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function sendError(reply: FastifyReply, status: number, error: string) {
  return reply.status(status).send({ error });
}

function validateRequest(body: unknown): { valid: true; data: AntigravityExtractRequest } | { valid: false; error: string } {
  if (!body || typeof body !== 'object') {
    return { valid: false, error: 'Request body must be an object' };
  }

  const data = body as Record<string, unknown>;

  if (typeof data.sessionId !== 'string' || !data.sessionId) {
    return { valid: false, error: 'sessionId is required' };
  }
  if (typeof data.projectPath !== 'string') {
    return { valid: false, error: 'projectPath is required' };
  }
  if (typeof data.title !== 'string') {
    return { valid: false, error: 'title is required' };
  }
  if (typeof data.planContent !== 'string') {
    return { valid: false, error: 'planContent is required' };
  }

  return {
    valid: true,
    data: {
      sessionId: data.sessionId as string,
      projectPath: data.projectPath as string,
      linkedCommit: typeof data.linkedCommit === 'string' ? data.linkedCommit : null,
      title: data.title as string,
      metadataSummary: typeof data.metadataSummary === 'string' ? data.metadataSummary : '',
      planContent: data.planContent as string,
      taskContent: typeof data.taskContent === 'string' ? data.taskContent : '',
      filesTouched: Array.isArray(data.filesTouched) ? data.filesTouched.filter((f): f is string => typeof f === 'string') : [],
      completionStatus: data.completionStatus === 'partial' ? 'partial' : 'complete',
      updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : new Date().toISOString(),
    },
  };
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

// ─────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────

export default async function antigravityRoutes(fastify: FastifyInstance) {
  fastify.post<{ Params: { id: string } }>(
    '/:id/antigravity/extract',
    {
      preHandler: [requireAuth, requireTeamMember],
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const { id: teamId } = request.params;
      const user = getAuthenticatedUser(request);

      // Validate format
      const validation = validateRequest(request.body);
      if (!validation.valid) {
        return sendError(reply, 400, validation.error);
      }

      const req = validation.data;

      // Skip if no plan content
      if (!req.planContent.trim()) {
        return { success: true, action: 'skip', reason: 'no plan content' };
      }

      // Check Haiku availability
      if (!isHaikuAvailable()) {
        console.log(`[ANTIGRAVITY] Haiku not available (no ANTHROPIC_API_KEY)`);
        return sendError(reply, 503, 'Extraction service unavailable');
      }

      // Extract with Haiku
      const extracted = await extractFromAntigravityData(req);

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
          original_query: req.title,
          reasoning_trace: extracted.reasoning_trace,
          decisions: extracted.decisions,
        });

        if (chunks && chunks.length > 0) {
          const embeddingsArray = chunks.map(c => `"[${c.embedding.join(',')}]"`);
          const embeddingsStr = `{${embeddingsArray.join(',')}}`;

          const { data, error: rpcError } = await supabase.rpc('hybrid_search_match', {
            p_team_id: teamId,
            p_project_path: req.projectPath,
            p_query_embeddings: embeddingsStr,
            p_query_text: req.title,
            p_semantic_threshold: 0.5,
            p_limit: 1,
          });

          if (rpcError) {
            fastify.log.error(`[ANTIGRAVITY] RPC error: ${rpcError.message}`);
          }

          if (data && data.length > 0) {
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
        const sessionContext: SessionContext = {
          task_type: extracted.task_type,
          original_query: req.title,
          files_touched: extracted.files_touched,
        };

        updateResult = await shouldUpdateMemory(matchedMemory, extracted, sessionContext);

        if (!updateResult.should_update) {
          return { success: true, action: 'skip', reason: updateResult.reason };
        }

        action = 'update';
        memoryId = matchedMemory.id;
      }

      // Prepare memory data
      const now = new Date().toISOString();
      let memoryData: Record<string, unknown>;

      if (action === 'update' && matchedMemory && updateResult) {
        // MERGE LOGIC
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

        // Handle reasoning evolution
        const existingReasoningEvolution = matchedMemory.reasoning_evolution || [];
        const reasoningEvolution = [...existingReasoningEvolution];
        if (updateResult.condensed_old_reasoning) {
          reasoningEvolution.push({
            content: updateResult.condensed_old_reasoning,
            date: now,
          });
        }

        // Handle evolution steps
        const existingEvolution = matchedMemory.evolution_steps || [];
        const baseEvolution = updateResult.consolidated_evolution_steps || existingEvolution;
        const evolutionSteps = [...baseEvolution];
        if (updateResult.evolution_summary) {
          evolutionSteps.push({
            summary: updateResult.evolution_summary,
            date: now,
          });
        }

        // Apply max limits
        const MAX_DECISIONS = 20;
        const MAX_EVOLUTION_STEPS = 10;
        const MAX_REASONING_EVOLUTION = 5;

        memoryData = {
          team_id: teamId,
          user_id: user.id,
          project_path: req.projectPath,
          original_query: req.title,
          goal: extracted.goal,
          system_name: extracted.system_name,
          summary: extracted.summary,
          reasoning_trace: extracted.reasoning_trace,
          decisions: allDecisions.slice(-MAX_DECISIONS),
          files_touched: extracted.files_touched,
          linked_commit: req.linkedCommit,
          status: req.completionStatus === 'complete' ? 'complete' : 'active',
          evolution_steps: evolutionSteps.slice(-MAX_EVOLUTION_STEPS),
          reasoning_evolution: reasoningEvolution.slice(-MAX_REASONING_EVOLUTION),
        };
      } else {
        // INSERT: simple structure
        memoryData = {
          team_id: teamId,
          user_id: user.id,
          project_path: req.projectPath,
          original_query: req.title,
          goal: extracted.goal,
          system_name: extracted.system_name,
          summary: extracted.summary,
          reasoning_trace: extracted.reasoning_trace,
          decisions: extracted.decisions.map(d => ({ ...d, date: now, active: true })),
          files_touched: extracted.files_touched,
          linked_commit: req.linkedCommit,
          status: req.completionStatus === 'complete' ? 'complete' : 'active',
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
          fastify.log.error(`[ANTIGRAVITY] Update failed: ${error.message}`);
          return sendError(reply, 500, 'Update failed');
        }
      } else {
        const { data, error } = await supabase
          .from('memories')
          .insert(memoryData)
          .select('id')
          .single();

        if (error || !data) {
          fastify.log.error(`[ANTIGRAVITY] Insert failed: ${error?.message}`);
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
          original_query: req.title,
          reasoning_trace: extracted.reasoning_trace,
          decisions: extracted.decisions,
        });

        if (chunks) {
          await saveChunks(memoryId, teamId, req.projectPath, chunks);
        }
      }

      return { success: true, action, memoryId, sessionId: req.sessionId };
    }
  );
}

