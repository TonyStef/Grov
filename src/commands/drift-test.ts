// grov drift-test - Debug command for testing drift detection
// Usage: grov drift-test "your prompt here" [--session <id>] [--goal "original goal"]
//
// NOTE: This command creates mock ACTIONS from the prompt for testing.
// In real usage, actions are parsed from Claude's JSONL session file.

import 'dotenv/config';
import { getSessionState, createSessionState, type SessionState } from '../lib/store.js';
import { extractIntent, isAnthropicAvailable } from '../lib/llm-extractor.js';
import { buildDriftCheckInput, checkDrift, checkDriftBasic, DRIFT_CONFIG } from '../lib/drift-checker.js';
import { determineCorrectionLevel, buildCorrection } from '../lib/correction-builder.js';
import type { ClaudeAction } from '../lib/session-parser.js';

export interface DriftTestOptions {
  session?: string;
  goal?: string;
  verbose?: boolean;
}

export async function driftTest(prompt: string, options: DriftTestOptions): Promise<void> {
  console.log('=== GROV DRIFT TEST ===\n');

  // Check API availability
  const llmAvailable = isAnthropicAvailable();
  console.log(`Anthropic API: ${llmAvailable ? 'AVAILABLE' : 'NOT AVAILABLE (using fallback)'}`);
  console.log('');

  // Get or create session state
  let sessionState = options.session ? getSessionState(options.session) : null;

  // If no session, create a test one with provided or extracted goal
  if (!sessionState) {
    console.log('No session provided, creating test session...');

    const goalText = options.goal || prompt;
    const intent = await extractIntent(goalText);

    console.log('\n--- Extracted Intent ---');
    console.log(`Goal: ${intent.goal}`);
    console.log(`Scope: ${intent.expected_scope.join(', ') || 'none'}`);
    console.log(`Constraints: ${intent.constraints.join(', ') || 'none'}`);
    console.log(`Keywords: ${intent.keywords.join(', ')}`);
    console.log('');

    // Create temporary session state in memory (not persisted unless session ID provided)
    sessionState = {
      session_id: options.session || 'test-session',
      project_path: process.cwd(),
      original_goal: intent.goal,
      actions_taken: [],
      files_explored: [],
      current_intent: undefined,
      drift_warnings: [],
      start_time: new Date().toISOString(),
      last_update: new Date().toISOString(),
      status: 'active',
      expected_scope: intent.expected_scope,
      constraints: intent.constraints,
      success_criteria: intent.success_criteria,
      keywords: intent.keywords,
      last_drift_score: undefined,
      escalation_count: 0,
      pending_recovery_plan: undefined,
      drift_history: [],
      last_checked_at: 0  // New field for action tracking
    };

    // Persist if session ID was provided
    if (options.session) {
      try {
        createSessionState({
          session_id: options.session,
          project_path: process.cwd(),
          original_goal: intent.goal,
          expected_scope: intent.expected_scope,
          constraints: intent.constraints,
          success_criteria: intent.success_criteria,
          keywords: intent.keywords
        });
        console.log(`Session state persisted: ${options.session}`);
      } catch {
        // Might already exist, ignore
      }
    }
  } else {
    console.log(`Using existing session: ${options.session}`);
    console.log(`Original goal: ${sessionState.original_goal}`);
    console.log(`Escalation count: ${sessionState.escalation_count}`);
    console.log(`Drift history: ${(sessionState.drift_history || []).length} events`);
    console.log('');
  }

  // Ensure sessionState is not null at this point
  if (!sessionState) {
    console.error('Failed to create session state');
    process.exit(1);
  }

  // Create mock actions from prompt for testing
  // In real usage, actions are parsed from Claude's JSONL session file
  const mockFiles = extractFilesFromPrompt(prompt);
  const mockActions: ClaudeAction[] = mockFiles.length > 0
    ? mockFiles.map((file, i) => ({
        type: 'edit' as const,
        files: [file],
        timestamp: Date.now() + i * 1000
      }))
    : [{ type: 'edit' as const, files: ['mock-file.ts'], timestamp: Date.now() }];

  console.log('--- Mock Actions (from prompt) ---');
  console.log(`Files detected: ${mockFiles.join(', ') || 'none (using mock-file.ts)'}`);
  console.log('');

  // Build drift check input using ACTIONS (not prompt!)
  const driftInput = buildDriftCheckInput(mockActions, sessionState.session_id, sessionState);

  console.log('--- Drift Check Input ---');
  console.log(`Actions: ${mockActions.map(a => `${a.type}:${a.files.join(',')}`).join(' | ')}`);
  console.log('');

  // Run drift check
  console.log('--- Running Drift Check ---');

  let result;
  if (llmAvailable) {
    console.log('Using LLM-based detection...');
    result = await checkDrift(driftInput);
  } else {
    console.log('Using basic (fallback) detection...');
    result = checkDriftBasic(driftInput);
  }

  console.log('');
  console.log('--- Drift Check Result ---');
  console.log(`Score: ${result.score}/10`);
  console.log(`Type: ${result.type}`);
  console.log(`Diagnostic: ${result.diagnostic}`);

  if (result.boundaries.length > 0) {
    console.log(`Boundaries: ${result.boundaries.join(', ')}`);
  }

  if (result.recoveryPlan?.steps) {
    console.log('Recovery steps:');
    for (const step of result.recoveryPlan.steps) {
      const file = step.file ? `[${step.file}] ` : '';
      console.log(`  - ${file}${step.action}`);
    }
  }

  console.log('');

  // Determine correction level
  const level = determineCorrectionLevel(result.score, sessionState.escalation_count);

  console.log('--- Correction Level ---');
  console.log(`Level: ${level || 'NONE (no correction needed)'}`);
  console.log('');

  // Show thresholds
  console.log('--- Thresholds (with escalation=%d) ---', sessionState.escalation_count);
  console.log(`>= ${DRIFT_CONFIG.SCORE_NO_INJECTION - sessionState.escalation_count}: No correction`);
  console.log(`>= ${DRIFT_CONFIG.SCORE_NUDGE - sessionState.escalation_count}: Nudge`);
  console.log(`>= ${DRIFT_CONFIG.SCORE_CORRECT - sessionState.escalation_count}: Correct`);
  console.log(`>= ${DRIFT_CONFIG.SCORE_INTERVENE - sessionState.escalation_count}: Intervene`);
  console.log(`< ${DRIFT_CONFIG.SCORE_INTERVENE - sessionState.escalation_count}: Halt`);
  console.log('');

  // Build and show correction if applicable
  if (level) {
    console.log('--- Correction Output ---');
    const correction = buildCorrection(result, sessionState, level);
    console.log(correction);
  } else {
    console.log('No correction needed for this prompt.');
  }

  console.log('\n=== END DRIFT TEST ===');
}

/**
 * Extract file paths from a prompt for mock action creation
 */
function extractFilesFromPrompt(prompt: string): string[] {
  const patterns = [
    // Absolute paths: /Users/dev/file.ts
    /(?:^|\s)(\/[\w\-\.\/]+\.\w+)/g,
    // Relative paths with ./: ./src/file.ts
    /(?:^|\s)(\.\/[\w\-\.\/]+\.\w+)/g,
    // Relative paths: src/file.ts or path/to/file.ts
    /(?:^|\s)([\w\-]+\/[\w\-\.\/]+\.\w+)/g,
    // Simple filenames with extension: file.ts
    /(?:^|\s|['"`])([\w\-]+\.\w{1,5})(?:\s|$|,|:|['"`])/g,
  ];

  const files = new Set<string>();

  for (const pattern of patterns) {
    const matches = prompt.matchAll(pattern);
    for (const match of matches) {
      const file = match[1].trim();
      if (file && !file.match(/^(http|https|ftp|mailto|tel)/) && !file.match(/^\d+\.\d+/)) {
        files.add(file);
      }
    }
  }

  return [...files];
}
