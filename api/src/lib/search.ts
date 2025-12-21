// Hybrid search helper function
// Centralizes embedding generation and RPC call logic

import { supabase } from '../db/client.js';
import { generateEmbedding, isEmbeddingEnabled } from './embeddings.js';
import type { ReasoningTraceEntry } from '@grov/shared';

export interface HybridSearchOptions {
  threshold: number;
  limit: number;
  currentFiles?: string[];
}

export interface HybridSearchResult {
  id: string;
  team_id: string;
  user_id: string | null;
  client_task_id: string | null;
  project_path: string;
  original_query: string;
  goal: string | null;
  reasoning_trace: ReasoningTraceEntry[];
  files_touched: string[];
  decisions: Array<{ tags?: string; choice: string; reason: string; date?: string; active?: boolean }>;
  constraints: string[];
  tags: string[];
  status: string;
  linked_commit: string | null;
  created_at: string;
  evolution_steps: Array<{ summary: string; date: string }>;
  reasoning_evolution: Array<{ content: string; date: string }>;
  semantic_score: number;
  lexical_raw_score: number;
  lexical_score: number;
  combined_score: number;
  file_boost_applied: boolean;
}

/**
 * Perform hybrid search on memories
 * Combines semantic (embedding) and lexical (text) search with optional file boost
 *
 * @param teamId - Team UUID
 * @param projectPath - Project path to filter by
 * @param queryText - Text to search for (used for embedding generation and lexical search)
 * @param options - Search options (threshold, limit, currentFiles)
 * @returns Array of matching memories with scores, or null if error/disabled
 */
export async function hybridSearchMemories(
  teamId: string,
  projectPath: string,
  queryText: string,
  options: HybridSearchOptions
): Promise<{ data: HybridSearchResult[] | null; error: string | null }> {
  // Check if embeddings are enabled
  if (!isEmbeddingEnabled()) {
    return { data: null, error: 'Embeddings disabled' };
  }

  // Validate inputs
  if (!queryText || queryText.trim().length === 0) {
    return { data: null, error: 'Empty query text' };
  }

  // Generate embedding for query
  const queryEmbedding = await generateEmbedding(queryText);
  if (!queryEmbedding) {
    console.error('[SEARCH] Failed to generate embedding');
    return { data: null, error: 'Failed to generate embedding' };
  }

  // Convert embedding array to PostgreSQL vector string format
  const embeddingStr = `[${queryEmbedding.join(',')}]`;

  // Prepare current files array
  const currentFilesArray = options.currentFiles || [];

  // Call hybrid_search_memories RPC function
  const { data, error } = await supabase.rpc('hybrid_search_memories', {
    p_team_id: teamId,
    p_project_path: projectPath,
    p_query_embedding: embeddingStr,
    p_query_text: queryText,
    p_current_files: currentFilesArray,
    p_similarity_threshold: options.threshold,
    p_limit: options.limit,
  });

  if (error) {
    console.error(`[SEARCH] RPC failed: ${error.message}`);
    return { data: null, error: error.message };
  }

  return { data: data || [], error: null };
}

