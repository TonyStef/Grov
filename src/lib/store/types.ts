// Store types and interfaces

// Task status types
export type TaskStatus = 'complete' | 'question' | 'partial' | 'abandoned';

// Task trigger reasons (when saving to team memory)
export type TriggerReason = 'complete' | 'threshold' | 'abandoned';

// Task data structure (team memory)
export interface Task {
  id: string;
  project_path: string;
  user?: string;
  original_query: string;
  goal?: string;
  reasoning_trace: string[];
  files_touched: string[];
  decisions: Array<{ choice: string; reason: string }>;
  constraints: string[];
  status: TaskStatus;
  trigger_reason?: TriggerReason;
  linked_commit?: string;
  parent_task_id?: string;
  turn_number?: number;
  tags: string[];
  created_at: string;
  synced_at?: string | null;
  sync_error?: string | null;
}

// Input for creating a new task
export interface CreateTaskInput {
  project_path: string;
  user?: string;
  original_query: string;
  goal?: string;
  reasoning_trace?: string[];
  files_touched?: string[];
  decisions?: Array<{ choice: string; reason: string }>;
  constraints?: string[];
  status: TaskStatus;
  trigger_reason?: TriggerReason;
  linked_commit?: string;
  parent_task_id?: string;
  turn_number?: number;
  tags?: string[];
}

// Session state status types
export type SessionStatus = 'active' | 'completed' | 'abandoned';

// Session mode for drift state machine
export type SessionMode = 'normal' | 'drifted' | 'forced';

// Task type for session hierarchy
export type TaskType = 'main' | 'subtask' | 'parallel';

// Recovery plan for drift correction (hook uses)
export interface RecoveryPlan {
  steps: Array<{
    file?: string;
    action: string;
  }>;
}

// Drift event tracked per prompt (hook uses)
export interface DriftEvent {
  timestamp: string;
  score: number;
  level: string;
  prompt_summary: string;
}

// Base fields (used by both hook and proxy)
interface SessionStateBase {
  session_id: string;
  user_id?: string;
  project_path: string;
  original_goal?: string;
  expected_scope: string[];
  constraints: string[];
  keywords: string[];
  escalation_count: number;
  last_checked_at: number;
  start_time: string;
  last_update: string;
  status: SessionStatus;
}

// Hook-specific fields (drift detection)
interface HookFields {
  success_criteria?: string[];
  last_drift_score?: number;
  pending_recovery_plan?: RecoveryPlan;
  drift_history?: DriftEvent[];
  actions_taken?: string[];
  files_explored?: string[];
  current_intent?: string;
  drift_warnings?: string[];
}

// Proxy-specific fields (session management)
interface ProxyFields {
  token_count?: number;
  session_mode?: SessionMode;
  waiting_for_recovery?: boolean;
  last_clear_at?: number;
  completed_at?: string;
  parent_session_id?: string;
  task_type?: TaskType;
  pending_correction?: string;
  pending_forced_recovery?: string;
  pending_clear_summary?: string;
  cached_injection?: string;
  final_response?: string;
}

// Full SessionState type (union of all)
export interface SessionState extends SessionStateBase, HookFields, ProxyFields {}

// Input for creating a new session state
export interface CreateSessionStateInput {
  session_id: string;
  user_id?: string;
  project_path: string;
  original_goal?: string;
  expected_scope?: string[];
  constraints?: string[];
  keywords?: string[];
  success_criteria?: string[];
  parent_session_id?: string;
  task_type?: TaskType;
}

// Step action types
export type StepActionType = 'edit' | 'write' | 'bash' | 'read' | 'glob' | 'grep' | 'task' | 'other';

// Drift type classification
export type DriftType = 'none' | 'minor' | 'major' | 'critical';

// Correction level
export type CorrectionLevel = 'nudge' | 'correct' | 'intervene' | 'halt';

// Step record (action log for current session)
export interface StepRecord {
  id: string;
  session_id: string;
  action_type: StepActionType;
  files: string[];
  folders: string[];
  command?: string;
  reasoning?: string;
  drift_score?: number;
  drift_type?: DriftType;
  is_key_decision: boolean;
  is_validated: boolean;
  correction_given?: string;
  correction_level?: CorrectionLevel;
  keywords: string[];
  timestamp: number;
}

// Input for creating a step
export interface CreateStepInput {
  session_id: string;
  action_type: StepActionType;
  files?: string[];
  folders?: string[];
  command?: string;
  reasoning?: string;
  drift_score?: number;
  drift_type?: DriftType;
  is_key_decision?: boolean;
  is_validated?: boolean;
  correction_given?: string;
  correction_level?: CorrectionLevel;
  keywords?: string[];
}

// Drift log entry (for rejected actions)
export interface DriftLogEntry {
  id: string;
  session_id: string;
  timestamp: number;
  action_type?: string;
  files: string[];
  drift_score: number;
  drift_reason?: string;
  correction_given?: string;
  recovery_plan?: Record<string, unknown>;
}

// Input for creating drift log entry
export interface CreateDriftLogInput {
  session_id: string;
  action_type?: string;
  files?: string[];
  drift_score: number;
  drift_reason?: string;
  correction_given?: string;
  recovery_plan?: Record<string, unknown>;
}
