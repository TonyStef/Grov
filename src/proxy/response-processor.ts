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
 * Group of steps that share the same Claude response (reasoning)
 * Used to reconstruct full context when sending to Haiku
 */
interface ReasoningGroup {
  reasoning: string;
  actions: Array<{
    type: string;
    files: string[];
    folders: string[];
    command?: string;
  }>;
  allFiles: string[];
  allFolders: string[];
}

/**
 * Group steps by reasoning (non-NULL starts a group, NULLs continue it)
 * Steps from the same Claude response share identical reasoning, stored only on the first.
 */
function groupStepsByReasoning(steps: StepRecord[]): ReasoningGroup[] {
  const groups: ReasoningGroup[] = [];
  let currentGroup: ReasoningGroup | null = null;

  for (const step of steps) {
    if (step.reasoning && step.reasoning.length > 0) {
      // Step with reasoning = start new group
      if (currentGroup) {
        groups.push(currentGroup);
      }
      currentGroup = {
        reasoning: step.reasoning,
        actions: [{
          type: step.action_type,
          files: step.files || [],
          folders: step.folders || [],
          command: step.command ?? undefined,
        }],
        allFiles: [...(step.files || [])],
        allFolders: [...(step.folders || [])],
      };
    } else if (currentGroup) {
      // Step without reasoning = continue current group
      currentGroup.actions.push({
        type: step.action_type,
        files: step.files || [],
        folders: step.folders || [],
        command: step.command ?? undefined,
      });
      currentGroup.allFiles.push(...(step.files || []));
      currentGroup.allFolders.push(...(step.folders || []));
    }
    // Edge case: step without reasoning and no current group = skip (shouldn't happen with new code)
  }

  // Push last group
  if (currentGroup) {
    groups.push(currentGroup);
  }

  return groups;
}

/**
 * Format grouped steps for Haiku prompt
 * Provides structured XML with reasoning + associated actions and files
 */
function formatGroupsForHaiku(groups: ReasoningGroup[]): string {
  if (groups.length === 0) {
    return '';
  }

  return groups.map((g, i) => {
    const actionLines = g.actions.map(a => {
      let line = `- ${a.type}`;
      if (a.files.length > 0) line += `: ${a.files.join(', ')}`;
      if (a.command) line += ` (command: ${a.command.substring(0, 50)})`;
      return line;
    }).join('\n');

    const uniqueFiles = [...new Set(g.allFiles)];

    return `<response index="${i + 1}">
<reasoning>
${g.reasoning}
</reasoning>
<actions_performed>
${actionLines}
</actions_performed>
<files_touched>${uniqueFiles.join(', ') || 'none'}</files_touched>
</response>`;
  }).join('\n\n###\n\n');
}

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
  // NOTE: Do NOT invalidate cache after sync - cache persists until CLEAR/Summary/restart
  // Next SESSION will get fresh data, current session keeps its context
  syncTask(task)
    .then((success) => {
      if (success) {
        markTaskSynced(task.id);
        console.log(`[SYNC] Task ${task.id.substring(0, 8)} synced to cloud`);
      } else {
        setTaskSyncError(task.id, 'Sync not enabled or team not configured');
        console.log(`[SYNC] Task ${task.id.substring(0, 8)} sync skipped (not enabled)`);
      }
    })
    .catch((err) => {
      const message = err instanceof Error ? err.message : 'Unknown sync error';
      setTaskSyncError(task.id, message);
      console.error(`[SYNC] Task ${task.id.substring(0, 8)} sync failed: ${message}`);
      // NOTE: Do NOT invalidate cache - data not in cloud
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
      // Group steps by reasoning to avoid duplicates and preserve action context
      const groups = groupStepsByReasoning(steps);
      let formattedSteps = formatGroupsForHaiku(groups);

      // Add final_response as separate section if exists and is different from grouped reasoning
      if (sessionState.final_response && sessionState.final_response.length > 100) {
        const finalAlreadyIncluded = groups.some(g =>
          g.reasoning.includes(sessionState.final_response!.substring(0, 100))
        );
        if (!finalAlreadyIncluded) {
          if (formattedSteps.length > 0) {
            formattedSteps += '\n\n###\n\n';
          }
          formattedSteps += `<final_response>\n${sessionState.final_response.substring(0, 8000)}\n</final_response>`;
        }
      }

      if (formattedSteps.length > 50) {
        const extracted = await extractReasoningAndDecisions(
          formattedSteps,
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
