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
  choice: string;
  reason: string;
}

// Memory stored in the database
export interface Memory {
  id: string;
  team_id: string;
  user_id: string | null;
  project_path: string;
  original_query: string;
  goal: string | null;
  reasoning_trace: string[];
  files_touched: string[];
  decisions: Decision[];
  constraints: string[];
  tags: string[];
  status: MemoryStatus;
  linked_commit: string | null;
  created_at: string;
}

// Input for creating a new memory (CLI sync)
export interface CreateMemoryInput {
  project_path: string;
  original_query: string;
  goal?: string;
  reasoning_trace?: string[];
  files_touched?: string[];
  decisions?: Decision[];
  constraints?: string[];
  tags?: string[];
  status: MemoryStatus;
  linked_commit?: string;
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
