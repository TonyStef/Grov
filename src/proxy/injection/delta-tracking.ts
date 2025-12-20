// Delta tracking - avoid duplicate injections across requests

import type { SessionState } from '../../lib/store.js';
import { getEditedFiles, getKeyDecisions } from '../../lib/store.js';
import { smartTruncate } from '../../lib/utils.js';

export interface SessionInjectionTracking {
  files: Set<string>;        // Files already mentioned in user message injection
  decisionIds: Set<string>;  // Step IDs of key decisions already injected
  reasonings: Set<string>;   // Reasoning content hashes already injected
}

const sessionInjectionTracking = new Map<string, SessionInjectionTracking>();

export function getOrCreateTracking(sessionId: string): SessionInjectionTracking {
  if (!sessionInjectionTracking.has(sessionId)) {
    sessionInjectionTracking.set(sessionId, {
      files: new Set(),
      decisionIds: new Set(),
      reasonings: new Set(),
    });
  }
  return sessionInjectionTracking.get(sessionId)!;
}

export function clearSessionTracking(sessionId: string): void {
  sessionInjectionTracking.delete(sessionId);
}

export function buildDynamicInjection(
  sessionId: string,
  sessionState: SessionState | null,
  logger?: { info: (data: Record<string, unknown>) => void }
): string | null {
  const tracking = getOrCreateTracking(sessionId);
  const parts: string[] = [];
  const debugInfo: Record<string, unknown> = {};

  // 1. Get edited files (delta - not already injected)
  const allEditedFiles = getEditedFiles(sessionId);
  const newFiles = allEditedFiles.filter(f => !tracking.files.has(f));
  debugInfo.totalEditedFiles = allEditedFiles.length;
  debugInfo.newEditedFiles = newFiles.length;
  debugInfo.alreadyTrackedFiles = tracking.files.size;

  if (newFiles.length > 0) {
    // Track and add to injection
    newFiles.forEach(f => tracking.files.add(f));
    const fileNames = newFiles.slice(0, 5).map(f => f.split('/').pop());
    parts.push(`[EDITED: ${fileNames.join(', ')}]`);
    debugInfo.editedFilesInjected = fileNames;
  }

  // 2. Get key decisions with reasoning (delta - not already injected)
  const keyDecisions = getKeyDecisions(sessionId, 5);
  debugInfo.totalKeyDecisions = keyDecisions.length;
  debugInfo.alreadyTrackedDecisions = tracking.decisionIds.size;

  const newDecisions = keyDecisions.filter(d =>
    !tracking.decisionIds.has(d.id) &&
    d.reasoning &&
    !tracking.reasonings.has(d.reasoning)
  );
  debugInfo.newKeyDecisions = newDecisions.length;

  for (const decision of newDecisions.slice(0, 3)) {
    tracking.decisionIds.add(decision.id);
    tracking.reasonings.add(decision.reasoning!);
    const truncated = smartTruncate(decision.reasoning!, 120);
    parts.push(`[DECISION: ${truncated}]`);

    // Log the original and truncated reasoning for debugging
    if (logger) {
      logger.info({
        msg: 'Key decision reasoning extracted',
        originalLength: decision.reasoning!.length,
        truncatedLength: truncated.length,
        original: decision.reasoning!.substring(0, 200) + (decision.reasoning!.length > 200 ? '...' : ''),
        truncated,
      });
    }
  }
  debugInfo.decisionsInjected = newDecisions.slice(0, 3).length;

  // 3. Add drift correction if pending
  if (sessionState?.pending_correction) {
    parts.push(`[DRIFT: ${sessionState.pending_correction}]`);
    debugInfo.hasDriftCorrection = true;
    debugInfo.driftCorrectionLength = sessionState.pending_correction.length;
    console.log(`[DRIFT] Correction injected (${sessionState.pending_correction.length} chars)`);
  }

  // 4. Add forced recovery if pending
  if (sessionState?.pending_forced_recovery) {
    parts.push(`[RECOVERY: ${sessionState.pending_forced_recovery}]`);
    debugInfo.hasForcedRecovery = true;
    debugInfo.forcedRecoveryLength = sessionState.pending_forced_recovery.length;
  }

  // Log debug info
  if (logger) {
    logger.info({
      msg: 'Dynamic injection build details',
      ...debugInfo,
      partsCount: parts.length,
    });
  }

  if (parts.length === 0) {
    return null;
  }

  const injection = '---\n[GROV CONTEXT]\n' + parts.join('\n');

  // Log final injection content
  if (logger) {
    logger.info({
      msg: 'Dynamic injection content',
      size: injection.length,
      content: injection,
    });
  }

  return injection;
}
