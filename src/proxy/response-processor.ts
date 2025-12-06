// Response processor - handles team memory save triggers and cleanup
// Reference: plan_proxy_local.md Section 4.6

import {
  getSessionState,
  getValidatedSteps,
  deleteStepsForSession,
  deleteSessionState,
  createTask,
  markTaskSynced,
  setTaskSyncError,
  type SessionState,
  type StepRecord,
  type TriggerReason,
} from '../lib/store.js';
import { syncTask } from '../lib/cloud-sync.js';
import {
  extractReasoning,
  isLLMAvailable,
  extractReasoningAndDecisions,
  isReasoningExtractionAvailable,
} from '../lib/llm-extractor.js';
import type { ParsedSession } from '../lib/jsonl-parser.js';

/**
 * Save session to team memory
 * Called on: task complete, subtask complete, session abandoned
 */
export async function saveToTeamMemory(
  sessionId: string,
  triggerReason: TriggerReason
): Promise<void> {
  const sessionState = getSessionState(sessionId);
  if (!sessionState) {
    return;
  }

  const steps = getValidatedSteps(sessionId);
  // Allow saving if: has steps OR has final_response OR is abandoned
  const hasFinalResponse = sessionState.final_response && sessionState.final_response.length > 100;
  if (steps.length === 0 && !hasFinalResponse && triggerReason !== 'abandoned') {
    return; // Nothing to save
  }

  // Build task data from session state and steps
  const taskData = await buildTaskFromSession(sessionState, steps, triggerReason);

  // Create task in team memory
  const task = createTask(taskData);

  // Fire-and-forget cloud sync; never block capture path
  syncTask(task)
    .then((success) => {
      if (success) {
        markTaskSynced(task.id);
      } else {
        setTaskSyncError(task.id, 'Sync not enabled or team not configured');
      }
    })
    .catch((err) => {
      const message = err instanceof Error ? err.message : 'Unknown sync error';
      setTaskSyncError(task.id, message);
    });
}

/**
 * Build task data from session state and steps
 */
async function buildTaskFromSession(
  sessionState: SessionState,
  steps: StepRecord[],
  triggerReason: TriggerReason
): Promise<{
  project_path: string;
  user?: string;
  original_query: string;
  goal?: string;
  reasoning_trace: string[];
  files_touched: string[];
  decisions: Array<{ choice: string; reason: string }>;
  constraints: string[];
  status: 'complete' | 'partial' | 'abandoned';
  trigger_reason: TriggerReason;
}> {
  // Aggregate files from steps (tool_use actions)
  const stepFiles = steps.flatMap(s => s.files);

  // Also extract file paths mentioned in reasoning text (Claude's text responses)
  const reasoningFiles = steps
    .filter(s => s.reasoning)
    .flatMap(s => {
      // Match common code file extensions
      const matches = s.reasoning?.match(/[\w\/.-]+\.(ts|js|tsx|jsx|py|go|rs|java|css|html|md|json|yaml|yml)/g) || [];
      // Filter out obvious non-paths (urls, version numbers)
      return matches.filter(m => !m.includes('://') && !m.match(/^\d+\.\d+/));
    });

  const filesTouched = [...new Set([...stepFiles, ...reasoningFiles])];

  // Build basic reasoning trace from steps (fallback)
  const basicReasoningTrace = steps
    .filter(s => s.is_key_decision || s.action_type === 'edit' || s.action_type === 'write')
    .slice(-10)
    .map(s => {
      if (s.action_type === 'edit' || s.action_type === 'write') {
        return `${s.action_type}: ${s.files.join(', ')}`;
      }
      if (s.action_type === 'bash' && s.command) {
        return `bash: ${s.command.substring(0, 50)}`;
      }
      return `${s.action_type}: ${s.files.length} files`;
    });

  // Try to use Anthropic Haiku for better reasoning & decisions extraction
  let reasoningTrace = basicReasoningTrace;
  let decisions: Array<{ choice: string; reason: string }> = [];
  let constraints: string[] = sessionState.constraints || [];

  if (isReasoningExtractionAvailable()) {
    try {
      // Collect reasoning from steps + final response
      const stepsReasoning = steps
        .map(s => s.reasoning)
        .filter((r): r is string => !!r && r.length > 10);

      // Include final response (contains the actual analysis/conclusion)
      if (sessionState.final_response && sessionState.final_response.length > 100) {
        stepsReasoning.push(sessionState.final_response);
      }

      if (stepsReasoning.length > 0) {
        const extracted = await extractReasoningAndDecisions(
          stepsReasoning,
          sessionState.original_goal || ''
        );

        if (extracted.reasoning_trace.length > 0) {
          reasoningTrace = extracted.reasoning_trace;
        }
        if (extracted.decisions.length > 0) {
          decisions = extracted.decisions;
        }
      }
    } catch {
      // Fall back to basic extraction
    }
  } else if (isLLMAvailable() && steps.length > 0) {
    // Fallback to OpenAI-based extraction if Anthropic not available
    try {
      const pseudoSession = buildPseudoSession(sessionState, steps);
      const extracted = await extractReasoning(pseudoSession);

      if (extracted.decisions.length > 0) {
        decisions = extracted.decisions;
      }
      if (extracted.constraints.length > 0) {
        constraints = [...new Set([...constraints, ...extracted.constraints])];
      }
    } catch {
      // Fall back to basic extraction
    }
  }

  return {
    project_path: sessionState.project_path,
    user: sessionState.user_id,
    original_query: sessionState.original_goal || 'Unknown task',
    goal: sessionState.original_goal,
    reasoning_trace: reasoningTrace,
    files_touched: filesTouched,
    decisions,
    constraints,
    status: triggerReason === 'abandoned' ? 'abandoned' : 'complete',
    trigger_reason: triggerReason,
  };
}

/**
 * Build pseudo ParsedSession for LLM extraction
 */
function buildPseudoSession(
  sessionState: SessionState,
  steps: StepRecord[]
): ParsedSession {
  return {
    sessionId: sessionState.session_id,
    projectPath: sessionState.project_path,
    startTime: sessionState.start_time,
    endTime: sessionState.last_update,
    userMessages: [sessionState.original_goal || ''],
    assistantMessages: steps.map(s => `[${s.action_type}] ${s.files.join(', ')}`),
    toolCalls: steps.map(s => ({
      name: s.action_type,
      input: { files: s.files, command: s.command },
    })),
    filesRead: steps.filter(s => s.action_type === 'read').flatMap(s => s.files),
    filesWritten: steps.filter(s => s.action_type === 'write' || s.action_type === 'edit').flatMap(s => s.files),
    rawEntries: [],
  };
}

/**
 * Clean up session data after save
 */
export function cleanupSession(sessionId: string): void {
  deleteStepsForSession(sessionId);
  deleteSessionState(sessionId);
}

/**
 * Save and cleanup session (for session end)
 */
export async function saveAndCleanupSession(
  sessionId: string,
  triggerReason: TriggerReason
): Promise<void> {
  await saveToTeamMemory(sessionId, triggerReason);
  cleanupSession(sessionId);
}
