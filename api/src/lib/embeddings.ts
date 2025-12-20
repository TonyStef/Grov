// Embedding generation using OpenAI text-embedding-3-small
// Used for semantic search in hybrid memory retrieval
//
// Architecture: Chunk-based embeddings (Parent Document Retrieval)
// Each memory is split into chunks (summary, goal, query, reasoning entries, decision entries)
// Each chunk gets its own embedding for fine-grained semantic search

import OpenAI from 'openai';

// Chunk types for memory_chunks table
export type ChunkType = 'summary' | 'query' | 'goal' | 'reasoning' | 'decision';

// Chunk object ready for database insert
export interface MemoryChunk {
  chunk_type: ChunkType;
  chunk_index: number;
  content: string;
  embedding: number[];
}

// Get OpenAI API key from environment
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Note: If OPENAI_API_KEY not set, semantic search will be disabled

// Initialize OpenAI client (only if key available)
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

// Model and dimensions
const EMBEDDING_MODEL = 'text-embedding-3-small';
const EMBEDDING_DIMENSIONS = 1536;

// Max tokens for embedding model (8191 for text-embedding-3-small)
// We use a conservative limit to leave room for tokenization overhead
const MAX_INPUT_CHARS = 30000; // ~7500 tokens at 4 chars/token average

/**
 * Check if embedding generation is available
 */
export function isEmbeddingEnabled(): boolean {
  return openai !== null;
}

/**
 * Generate embedding vector for text
 *
 * @param text - Text to embed
 * @returns Embedding vector (1536 dimensions) or null if failed/disabled
 */
export async function generateEmbedding(text: string): Promise<number[] | null> {
  if (!openai) {
    return null;
  }

  if (!text || text.trim().length === 0) {
    return null;
  }

  const inputText = text.substring(0, MAX_INPUT_CHARS);

  try {
    const response = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: inputText,
    });

    const embedding = response.data[0]?.embedding;

    if (!embedding || embedding.length !== EMBEDDING_DIMENSIONS) {
      console.error('[EMBEDDINGS] Invalid response');
      return null;
    }

    return embedding;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[EMBEDDINGS] FAILED: ${message}`);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// CHUNK-BASED EMBEDDINGS (New Architecture)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Strip semantic-diluting prefixes from chunk content before embedding
 * These prefixes reduce semantic similarity scores by adding noise
 * Strips ANYWHERE in text (not just at start) using global flag
 */
const PREFIXES_TO_STRIP = [
  /CONCLUSION:\s*/gi,
  /INSIGHT:\s*/gi,
  /Factual:\s*/gi,
  /Inferred:\s*/gi,
];

function stripPrefixes(text: string): string {
  let result = text;
  for (const prefix of PREFIXES_TO_STRIP) {
    result = result.replace(prefix, '');
  }
  return result.trim();
}

/**
 * Generate embeddings for multiple texts in a single API call
 * More efficient than calling generateEmbedding() multiple times
 *
 * @param texts - Array of texts to embed
 * @returns Array of embeddings (same order as input texts), or null if failed
 */
export async function generateEmbeddingsBatch(texts: string[]): Promise<number[][] | null> {
  if (!openai) {
    return null;
  }

  if (!texts || texts.length === 0) {
    return null;
  }

  // Filter out empty texts and truncate to max length
  const processedTexts = texts
    .map(t => (t || '').trim().substring(0, MAX_INPUT_CHARS))
    .filter(t => t.length > 0);

  if (processedTexts.length === 0) {
    return null;
  }

  try {
    const response = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: processedTexts,
    });

    if (!response.data || response.data.length !== processedTexts.length) {
      console.error('[EMBEDDINGS] Batch count mismatch');
      return null;
    }

    // Sort by index to ensure correct order
    const sorted = response.data.sort((a, b) => a.index - b.index);
    const embeddings = sorted.map(d => d.embedding);

    return embeddings;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[EMBEDDINGS] BATCH FAILED: ${message}`);
    return null;
  }
}

/**
 * Memory input type for chunk generation
 */
// Reasoning entry type (union for backwards compatibility)
type ReasoningEntryInput = string | { aspect?: string; tags?: string; conclusion: string; insight?: string | null };

export interface MemoryForChunks {
  system_name?: string | null;  // Parent system anchor - prefixed to ALL chunks
  summary?: string | null;
  goal?: string | null;
  original_query: string;
  reasoning_trace?: ReasoningEntryInput[];
  decisions?: Array<{ aspect?: string; tags?: string; choice: string; reason: string }>;
}

/**
 * Generate chunks with embeddings from a memory object
 *
 * This is the main function for the new chunk-based architecture.
 * It takes a memory and produces an array of chunks, each with its own embedding.
 *
 * Chunk types:
 * - summary: 1 chunk from memory.summary (if exists)
 * - query: 1 chunk from memory.original_query
 * - goal: 1 chunk from memory.goal (if exists)
 * - reasoning: N chunks, one per entry in memory.reasoning_trace
 * - decision: N chunks, one per entry in memory.decisions
 *
 * @param memory - Memory object with fields to chunk
 * @returns Array of MemoryChunk objects with embeddings, or null if failed
 */
export async function generateChunks(memory: MemoryForChunks): Promise<MemoryChunk[] | null> {
  if (!openai) {
    return null;
  }

  // Get system_name for prefixing all chunks (parent anchor for semantic search)
  const systemName = memory.system_name?.trim() || null;

  // Helper to prefix content with system_name
  const prefixWithSystem = (content: string): string => {
    if (!systemName) return content;
    return `${systemName}: ${content}`;
  };

  // Build chunk definitions (without embeddings yet)
  const chunkDefs: Array<{ type: ChunkType; index: number; content: string }> = [];

  // Summary chunk
  if (memory.summary && memory.summary.trim()) {
    chunkDefs.push({
      type: 'summary',
      index: 0,
      content: prefixWithSystem(memory.summary.trim()),
    });
  }

  // Query chunk (always present) - NO system_name prefix!
  // User's raw query should match exactly what INJECT uses for consistency
  if (memory.original_query && memory.original_query.trim()) {
    chunkDefs.push({
      type: 'query',
      index: 0,
      content: memory.original_query.trim(),  // Raw, no prefix
    });
  }

  // Goal chunk
  if (memory.goal && memory.goal.trim()) {
    chunkDefs.push({
      type: 'goal',
      index: 0,
      content: prefixWithSystem(memory.goal.trim()),
    });
  }

  // Reasoning chunks (one per entry)
  // Format: [system_name]: [aspect]: [conclusion]: [insight]
  if (memory.reasoning_trace && memory.reasoning_trace.length > 0) {
    memory.reasoning_trace.forEach((entry, idx) => {
      // Handle both object and string entries (backwards compatibility)
      if (typeof entry === 'object' && entry !== null) {
        // New format: object with aspect (or tags), conclusion, insight
        // Build content: [aspect]: [conclusion]: [insight]
        const parts: string[] = [];
        // Prefer aspect, fallback to tags for backwards compat
        const localTag = entry.aspect || entry.tags;
        if (localTag) parts.push(localTag);
        if (entry.conclusion) parts.push(entry.conclusion);
        if (entry.insight) parts.push(entry.insight);

        const localContent = parts.join(': ').trim();
        if (localContent && localContent.length > 2) {
          chunkDefs.push({
            type: 'reasoning',
            index: idx,
            content: prefixWithSystem(localContent),
          });
        }
      } else if (typeof entry === 'string' && entry.trim()) {
        // Old format: plain string
        chunkDefs.push({
          type: 'reasoning',
          index: idx,
          content: prefixWithSystem(entry.trim()),
        });
      }
    });
  }

  // Decision chunks (one per entry)
  // Format: [system_name]: [aspect]: [choice]: [reason]
  if (memory.decisions && memory.decisions.length > 0) {
    memory.decisions.forEach((decision, idx) => {
      if (decision.choice || decision.reason) {
        // Build content: [aspect]: [choice]: [reason]
        const parts: string[] = [];
        // Prefer aspect, fallback to tags for backwards compat
        const localTag = decision.aspect || decision.tags;
        if (localTag) parts.push(localTag);
        if (decision.choice) parts.push(decision.choice);
        if (decision.reason) parts.push(decision.reason);

        const localContent = parts.join(': ').trim();
        if (localContent && localContent.length > 2) {
          chunkDefs.push({
            type: 'decision',
            index: idx,
            content: prefixWithSystem(localContent),
          });
        }
      }
    });
  }

  if (chunkDefs.length === 0) {
    return [];
  }

  // Generate embeddings for all chunks in one batch call
  // Strip prefixes for embedding (keeps original content for DB storage)
  const texts = chunkDefs.map(c => stripPrefixes(c.content));
  const embeddings = await generateEmbeddingsBatch(texts);

  if (!embeddings || embeddings.length !== chunkDefs.length) {
    console.error('[CHUNKS] Failed to generate embeddings');
    return null;
  }

  // Combine chunk definitions with embeddings
  const chunks: MemoryChunk[] = chunkDefs.map((def, idx) => ({
    chunk_type: def.type,
    chunk_index: def.index,
    content: def.content,
    embedding: embeddings[idx],
  }));

  return chunks;
}
