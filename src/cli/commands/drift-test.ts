// grov drift-test - Debug command for testing drift detection
// Usage: grov drift-test "your prompt here" [--session <id>] [--goal "original goal"]
//
// NOTE: This command creates mock STEPS from the prompt for testing.
// In real usage, steps are tracked by the proxy from Claude's actions.

import 'dotenv/config';
import { getSessionState, createSessionState, type SessionState, type StepRecord } from '../../core/store/store.js';
import { analyzeTaskContext, type RequestHeaders } from '../../core/extraction/llm-extractor.js';
import { checkDrift, checkDriftBasic, scoreToCorrectionLevel, type DriftCheckResult } from '../../core/extraction/drift-checker-proxy.js';
import { buildCorrection, formatCorrectionForInjection } from '../../core/extraction/correction-builder-proxy.js';

// CLI uses env var for auth (not proxy headers)
// Creates mock headers matching what Claude Code would send
function getCliHeaders(): RequestHeaders | null {
  const apiKey = process.env.ANTHROPIC_API_KEY || process.env.GROV_API_KEY;
  if (!apiKey) return null;
  return {
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json',
  };
}

export interface DriftTestOptions {
  session?: string;
  goal?: string;
  verbose?: boolean;
}

export async function driftTest(prompt: string, options: DriftTestOptions): Promise<void> {
  console.log('=== GROV DRIFT TEST ===\n');

  // Get headers from env (CLI mode)
  const headers = getCliHeaders();
  console.log(`Anthropic API: ${headers ? 'AVAILABLE' : 'NOT AVAILABLE (using fallback)'}`);
  console.log('');

  if (!headers) {
    console.log('Set ANTHROPIC_API_KEY or GROV_API_KEY to enable LLM drift checking.');
    return;
  }

  // Get or create session state
  let sessionState = options.session ? getSessionState(options.session) : null;

  // If no session, create a test one with provided or extracted goal
  if (!sessionState) {
    console.log('No session provided, creating test session...');

    const goalText = options.goal || prompt;

    // Use analyzeTaskContext with mock context to extract goal and constraints
    const mockConversation = [{ role: 'user' as const, content: goalText }];
    const taskAnalysis = await analyzeTaskContext(
      null,                    // no existing session
      goalText,                // latest user message
      [],                      // no recent steps
      '',                      // no assistant response yet
      mockConversation,        // conversation history
      headers
    );

    console.log('\n--- Task Analysis ---');
    console.log(`Goal: ${taskAnalysis.current_goal}`);
    console.log(`Action: ${taskAnalysis.action}`);
    console.log(`Constraints: ${(taskAnalysis.constraints || []).join(', ') || 'none'}`);
    console.log('');

    // Create temporary session state
    sessionState = createSessionState({
      session_id: options.session || 'test-session-' + Date.now(),
      project_path: process.cwd(),
      original_goal: taskAnalysis.current_goal,
      constraints: taskAnalysis.constraints || [],
      task_type: 'main',
    });
  } else {
    console.log(`Using existing session: ${options.session}`);
    console.log(`Original goal: ${sessionState.original_goal}`);
    console.log(`Escalation count: ${sessionState.escalation_count}`);
    console.log('');
  }

  // Ensure sessionState is not null at this point
  if (!sessionState) {
    console.error('Failed to create session state');
    process.exit(1);
  }

  // Create mock steps from prompt for testing
  const mockFiles = extractFilesFromPrompt(prompt);
  const mockSteps: StepRecord[] = mockFiles.length > 0
    ? mockFiles.map((file, i) => ({
        id: `step-${i}`,
        session_id: sessionState!.session_id,
        action_type: 'edit' as const,
        files: [file],
        folders: [],
        timestamp: Date.now() + i * 1000,
        is_validated: true,
        is_key_decision: false,
        keywords: [],
      }))
    : [{
        id: 'step-0',
        session_id: sessionState.session_id,
        action_type: 'edit' as const,
        files: ['mock-file.ts'],
        folders: [],
        timestamp: Date.now(),
        is_validated: true,
        is_key_decision: false,
        keywords: [],
      }];

  console.log('--- Mock Steps (from prompt) ---');
  console.log(`Files detected: ${mockFiles.join(', ') || 'none (using mock-file.ts)'}`);
  console.log('');

  // Build drift check input
  const driftInput = {
    sessionState,
    recentSteps: mockSteps,
    latestUserMessage: prompt,
  };

  console.log('--- Drift Check Input ---');
  console.log(`Steps: ${mockSteps.map(s => `${s.action_type}:${s.files.join(',')}`).join(' | ')}`);
  console.log('');

  // Run drift check
  console.log('--- Running Drift Check ---');

  console.log('Using LLM-based detection...');
  const result = await checkDrift(driftInput, headers);

  console.log('');
  console.log('--- Drift Check Result ---');
  console.log(`Score: ${result.score}/10`);
  console.log(`Type: ${result.driftType}`);
  console.log(`Diagnostic: ${result.diagnostic}`);

  if (result.suggestedAction) {
    console.log(`Suggested Action: ${result.suggestedAction}`);
  }

  if (result.recoverySteps && result.recoverySteps.length > 0) {
    console.log('Recovery steps:');
    for (const step of result.recoverySteps) {
      console.log(`  - ${step}`);
    }
  }

  console.log('');

  // Determine correction level
  const level = scoreToCorrectionLevel(result.score);

  console.log('--- Correction Level ---');
  console.log(`Level: ${level || 'NONE (no correction needed)'}`);
  console.log('');

  // Show thresholds
  console.log('--- Thresholds ---');
  console.log(`>= 8: No correction`);
  console.log(`= 7: Nudge`);
  console.log(`5-6: Correct`);
  console.log(`3-4: Intervene`);
  console.log(`< 3: Halt`);
  console.log('');

  // Build and show correction if applicable
  if (level) {
    console.log('--- Correction Output ---');
    const correction = buildCorrection(result, sessionState, level);
    const formatted = formatCorrectionForInjection(correction);
    console.log(formatted);
  } else {
    console.log('No correction needed for this prompt.');
  }

  console.log('\n=== END DRIFT TEST ===');
}

/**
 * Extract file paths from a prompt for mock step creation
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
