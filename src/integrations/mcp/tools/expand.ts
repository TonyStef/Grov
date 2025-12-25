// grov_expand - get full details for memories by index

import { getMemoriesByIndices } from '../cache.js';
import type { Memory } from '@grov/shared';

export async function handleExpand(indices: number[]): Promise<string> {
  if (indices.length === 0) {
    return JSON.stringify({ error: 'No indices provided' });
  }

  const memories = getMemoriesByIndices(indices);

  if (memories.length === 0) {
    return JSON.stringify({
      error: 'No memories found. Call grov_preview first.',
    });
  }

  // Format full memory details
  const expanded = memories.map((m) => formatMemory(m));

  return JSON.stringify({
    memories: expanded,
    count: expanded.length,
  });
}

function formatMemory(m: Memory): object {
  return {
    id: m.id,
    goal: m.goal,
    original_query: m.original_query,
    reasoning_trace: m.reasoning_trace || [],
    decisions: m.decisions || [],
    files_touched: m.files_touched || [],
    evolution_steps: m.evolution_steps || [],
    created_at: m.created_at,
    updated_at: m.updated_at,
  };
}
