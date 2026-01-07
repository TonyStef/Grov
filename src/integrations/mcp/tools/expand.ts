// grov_expand - get full details for memory by ID

import { getMemoryById, getCachedIds } from '../cache.js';
import type { Memory } from '@grov/shared';

export async function handleExpand(id: string): Promise<string> {
  const memory = getMemoryById(id);

  if (!memory) {
    const cachedIds = getCachedIds();
    return JSON.stringify({
      error: `Memory not found: ${id}. Cached IDs: [${cachedIds.join(', ')}]. Call grov_preview first.`,
    });
  }

  // Format single memory
  const expanded = formatMemory(memory);

  return JSON.stringify({
    memory: expanded,
    instructions: buildPostExpandInstructions(),
  });
}

function buildPostExpandInstructions(): string {
  return `
YOU NOW HAVE YOUR VERIFIED KNOWLEDGE.

KB above = WHAT was done + WHY (reasoning, decisions, conclusions).
Your team already analyzed this. KB IS VERIFIED. KB IS CURRENT.

QUESTION OR IMPLEMENTATION?

QUESTION/EXPLANATION?
→ KB IS YOUR ANSWER. Respond DIRECTLY from it.
→ ZERO file reads. KB IS VERIFIED. KB IS THE CONTEXT.

IMPLEMENTATION?
→ KB gives you the APPROACH (reasoning + decisions).
→ Read ONLY: files you EDIT + files you IMPORT FROM.
→ Read each file ONCE. Never re-read.
→ No exploration. No verification reads. KB gave you context.

Was this memory insufficient? → Expand next most relevant.
Otherwise → proceed with task.
`.trim();
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
