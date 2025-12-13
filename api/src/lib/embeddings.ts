// Embedding generation using OpenAI text-embedding-3-small
// Used for semantic search in hybrid memory retrieval

import OpenAI from 'openai';

// Get OpenAI API key from environment
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!OPENAI_API_KEY) {
  console.warn('[EMBEDDINGS] OPENAI_API_KEY not set - semantic search will be disabled');
}

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
 * Build embedding text from memory fields
 * Concatenates: goal + original_query + reasoning_trace + decisions
 *
 * @param memory - Memory object with fields to embed
 * @returns Concatenated text for embedding
 */
export function buildEmbeddingText(memory: {
  goal?: string | null;
  original_query: string;
  reasoning_trace?: string[];
  decisions?: Array<{ choice: string; reason: string }>;
}): string {
  const parts: string[] = [];

  // Goal - primary semantic summary
  if (memory.goal) {
    parts.push(memory.goal);
  }

  // Original query - user intent
  parts.push(memory.original_query);

  // Reasoning trace - rich semantic content
  if (memory.reasoning_trace && memory.reasoning_trace.length > 0) {
    parts.push(...memory.reasoning_trace);
  }

  // Decisions - architectural context
  if (memory.decisions && memory.decisions.length > 0) {
    for (const decision of memory.decisions) {
      parts.push(`Decision: ${decision.choice}. Reason: ${decision.reason}`);
    }
  }

  // Join and truncate to fit model limits
  const text = parts.filter(Boolean).join('\n');
  return text.substring(0, MAX_INPUT_CHARS);
}

/**
 * Generate embedding vector for text
 *
 * @param text - Text to embed
 * @returns Embedding vector (1536 dimensions) or null if failed/disabled
 */
export async function generateEmbedding(text: string): Promise<number[] | null> {
  if (!openai) {
    console.warn('[EMBEDDINGS] OpenAI client not initialized - skipping embedding');
    return null;
  }

  if (!text || text.trim().length === 0) {
    console.warn('[EMBEDDINGS] Empty text provided - skipping embedding');
    return null;
  }

  try {
    const response = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: text.substring(0, MAX_INPUT_CHARS),
    });

    const embedding = response.data[0]?.embedding;

    if (!embedding || embedding.length !== EMBEDDING_DIMENSIONS) {
      console.error('[EMBEDDINGS] Invalid embedding response');
      return null;
    }

    return embedding;
  } catch (error) {
    // Log error but don't expose details to caller
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[EMBEDDINGS] Failed to generate embedding: ${message}`);
    return null;
  }
}

/**
 * Generate embedding for a memory object
 * Convenience wrapper that builds text and generates embedding
 *
 * @param memory - Memory object to embed
 * @returns Embedding vector or null if failed
 */
export async function generateMemoryEmbedding(memory: {
  goal?: string | null;
  original_query: string;
  reasoning_trace?: string[];
  decisions?: Array<{ choice: string; reason: string }>;
}): Promise<number[] | null> {
  const text = buildEmbeddingText(memory);
  return generateEmbedding(text);
}
