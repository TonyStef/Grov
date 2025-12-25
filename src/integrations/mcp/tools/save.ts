// grov_save - save work to team memory

import { fetchMatch } from '../../../core/cloud/api-client.js';
import { getSyncStatus } from '../../../core/cloud/credentials.js';
import { createTask } from '../store.js';
import { getProjectPath, setPendingDecision, wasShownInPreview } from '../cache.js';
import { syncTaskToCloud } from './sync.js';

export interface SaveInput {
  goal: string;
  original_query: string;
  summary: string;
  reasoning_trace: Array<{ conclusion: string; insight: string }>;
  decisions: Array<{ choice: string; reason: string }>;
  files_touched: string[];
  mode: 'agent' | 'planning' | 'ask';
}

export async function handleSave(input: SaveInput): Promise<string> {
  const syncStatus = getSyncStatus();
  const projectPath = getProjectPath();

  // Save locally first (instant)
  const taskId = createTask({
    project_path: projectPath,
    mode: input.mode,
    goal: input.goal,
    original_query: input.original_query,
    summary: input.summary,
    reasoning_trace: input.reasoning_trace,
    decisions: input.decisions,
    files_touched: input.files_touched,
  });

  // If sync not enabled, just return local save success
  if (!syncStatus?.enabled || !syncStatus.teamId) {
    return JSON.stringify({
      saved: true,
      synced: false,
      task_id: taskId,
      message: 'Saved locally. Enable sync with grov login.',
    });
  }

  // Check for matching memory
  try {
    const matchResult = await fetchMatch(syncStatus.teamId, {
      project_path: projectPath,
      goal: input.goal,
      original_query: input.original_query,
      reasoning_trace: input.reasoning_trace,
      decisions: input.decisions.map(d => ({ choice: d.choice, reason: d.reason })),
    });

    // No match - auto INSERT
    if (!matchResult.match) {
      await syncTaskToCloud(taskId, syncStatus.teamId, 'insert');
      return JSON.stringify({
        saved: true,
        synced: true,
        action: 'insert',
        task_id: taskId,
      });
    }

    // Match found - need LLM decision
    setPendingDecision(taskId, matchResult.match);

    const alreadySeen = wasShownInPreview(matchResult.match.id);

    return JSON.stringify({
      saved: true,
      needs_decision: true,
      task_id: taskId,
      match: {
        id: matchResult.match.id,
        goal: matchResult.match.goal,
        summary: matchResult.match.summary,
        decisions: matchResult.match.decisions,
        was_in_preview: alreadySeen,
      },
      message: 'Match found. Call grov_decide_update with "update" or "skip".',
    });

  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return JSON.stringify({
      saved: true,
      synced: false,
      task_id: taskId,
      error: msg,
    });
  }
}
