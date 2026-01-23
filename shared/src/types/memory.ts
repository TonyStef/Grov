/**
 * Memory types - synced reasoning from Claude Code sessions
 * Aligns with CLI Task type and Supabase memories table
 */

// Status of a memory/task
export type MemoryStatus = 'complete' | 'question' | 'partial' | 'abandoned';

// Trigger reason (why the memory was saved)
export type TriggerReason = 'complete' | 'threshold' | 'abandoned';

// Decision made during a task
export interface Decision {
  aspect?: string;  // Specific component (e.g., 'Backoff Strategy') - NEW for semantic search
  tags?: string;    // DEPRECATED: use aspect instead (kept for backwards compat)
  choice: string;
  reason: string;
  date?: string;    // YYYY-MM-DD format
  active?: boolean; // false if superseded by newer decision
  superseded_by?: {
    choice: string;   // the new decision that replaced this one
    reason: string;   // why the change was made
    date: string;     // when the replacement happened
  };
}

// Evolution step in memory history
export interface EvolutionStep {
  summary: string;  // 200-250 chars describing state at this point
  date: string;     // YYYY-MM-DD format
}

// Reasoning evolution entry (historical)
export interface ReasoningEvolutionEntry {
  content: string;  // condensed reasoning from previous version
  date: string;     // YYYY-MM-DD format
}

// Reasoning/Knowledge pair entry (new format with tags for semantic search)
export interface ReasoningEntry {
  aspect?: string;         // Specific component (e.g., 'Job State Model') - NEW for semantic search
  tags?: string;           // DEPRECATED: use aspect instead (kept for backwards compat)
  conclusion: string;      // Factual finding (prefixed with "CONCLUSION: ")
  insight?: string | null; // Analysis/implication (prefixed with "INSIGHT: ")
}

// Union type for backwards compatibility (string = old format, object = new format)
export type ReasoningTraceEntry = string | ReasoningEntry;

// Memory stored in the database
export interface Memory {
  id: string;
  team_id: string;
  user_id: string | null;
  client_task_id?: string | null;
  project_path: string;
  original_query: string;
  goal: string | null;
  system_name?: string | null;      // Parent system anchor (e.g., 'Retry Queue') - prefixes all chunks
  summary: string | null;           // Content summary for semantic search (~200-250 chars)
  reasoning_trace: ReasoningTraceEntry[];
  files_touched: string[];
  decisions: Decision[];
  constraints: string[];
  tags: string[];
  status: MemoryStatus;
  linked_commit: string | null;
  created_at: string;
  updated_at?: string;  // Set by trigger on UPDATE, defaults to created_at
  // Branch management
  branch: string;
  source_branch?: string | null;
  merged_at?: string | null;
  // Memory editing fields
  evolution_steps?: EvolutionStep[];
  reasoning_evolution?: ReasoningEvolutionEntry[];
}

// Input for creating/updating a memory (CLI sync)
export interface CreateMemoryInput {
  client_task_id?: string;
  project_path: string;
  original_query: string;
  goal?: string;
  system_name?: string;                        // Parent system anchor (e.g., 'Retry Queue') - prefixes all chunks
  summary?: string;                            // Content summary for semantic search (~200-250 chars)
  reasoning_trace?: ReasoningTraceEntry[];
  files_touched?: string[];
  decisions?: Decision[];
  constraints?: string[];
  tags?: string[];
  status: MemoryStatus;
  task_type?: 'information' | 'planning' | 'implementation';
  linked_commit?: string;
  // Branch management
  branch?: string;
  // Memory editing fields (for UPDATE path)
  memory_id?: string;                          // If present, triggers UPDATE instead of INSERT
  evolution_steps?: EvolutionStep[];
  reasoning_evolution?: ReasoningEvolutionEntry[];
  // Note: Embeddings are now generated as chunks in API (memory_chunks table)
  // No pre-computed embeddings needed - SYNC generates chunks automatically
}

// Memory list filters
export interface MemoryFilters {
  search?: string;
  tags?: string[];
  files?: string[];
  from?: string;
  to?: string;
  status?: MemoryStatus;
  user_id?: string;
  project_path?: string;
  branch?: string;
}

// Paginated memory list response
export interface MemoryListResponse {
  memories: Memory[];
  cursor: string | null;
  has_more: boolean;
}

// Memory sync request from CLI
export interface MemorySyncRequest {
  memories: CreateMemoryInput[];
}

// Memory sync response
export interface MemorySyncResponse {
  synced: number;
  failed: number;
  errors?: string[];
}
