// Antigravity Periodic Scanner
// Scans ~/.gemini/antigravity/brain/ for new/updated sessions
// and syncs them to the Grov API

import {
  antigravityExists,
  getAllSessionIds,
  parseSession,
  type AntigravitySession,
} from './antigravity-parser.js';
import {
  isSynced,
  needsUpdate,
  markSynced,
  pruneOldEntries,
} from './antigravity-sync-tracker.js';
import { getAccessToken, getSyncStatus } from '../../../core/cloud/credentials.js';
import { getApiUrl } from '../../../core/cloud/api-client.js';
import { mcpLog } from '../logger.js';

// ─────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────

const SCAN_INTERVAL_MS = 3 * 60 * 1000; // 3 minutes
let scannerInterval: ReturnType<typeof setInterval> | null = null;

// ─────────────────────────────────────────────────────────────
// API Sync
// ─────────────────────────────────────────────────────────────

interface SyncResult {
  success: boolean;
  action?: 'insert' | 'update' | 'skip';
  memoryId?: string;
  error?: string;
}

async function syncSessionToApi(
  session: AntigravitySession,
  teamId: string,
  token: string
): Promise<SyncResult> {
  const apiUrl = getApiUrl();
  const url = `${apiUrl}/teams/${teamId}/antigravity/extract`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(session),
    });

    if (!response.ok) {
      const text = await response.text();
      return { success: false, error: `HTTP ${response.status}: ${text}` };
    }

    const result = (await response.json()) as { success: boolean; action?: string; memoryId?: string };
    return {
      success: result.success,
      action: result.action as 'insert' | 'update' | 'skip' | undefined,
      memoryId: result.memoryId,
    };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Unknown error' };
  }
}

// ─────────────────────────────────────────────────────────────
// Scanner Logic
// ─────────────────────────────────────────────────────────────

export interface ScanResult {
  scanned: number;
  synced: number;
  updated: number;
  skipped: number;
  failed: number;
  errors: string[];
}

/**
 * Perform a single scan of Antigravity sessions
 */
export async function scanOnce(): Promise<ScanResult> {
  const result: ScanResult = {
    scanned: 0,
    synced: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    errors: [],
  };

  // Check prerequisites
  if (!antigravityExists()) {
    mcpLog('[ANTIGRAVITY-SCANNER] Antigravity not installed, skipping scan');
    return result;
  }

  const syncStatus = getSyncStatus();
  if (!syncStatus?.enabled || !syncStatus.teamId) {
    mcpLog('[ANTIGRAVITY-SCANNER] Sync not enabled or no team configured');
    return result;
  }

  const token = await getAccessToken();
  if (!token) {
    mcpLog('[ANTIGRAVITY-SCANNER] No access token, skipping scan');
    return result;
  }

  // Get all sessions
  const sessionIds = getAllSessionIds();
  mcpLog(`[ANTIGRAVITY-SCANNER] Found ${sessionIds.length} total sessions`);

  for (const sessionId of sessionIds) {
    result.scanned++;

    // Parse session
    const session = parseSession(sessionId);
    if (!session) {
      mcpLog(`[ANTIGRAVITY-SCANNER] Failed to parse session ${sessionId}`);
      continue;
    }

    // Check if needs sync
    const alreadySynced = isSynced(sessionId);
    const hasUpdates = needsUpdate(sessionId, session.planContent);

    if (alreadySynced && !hasUpdates) {
      result.skipped++;
      continue;
    }

    // Sync to API
    mcpLog(`[ANTIGRAVITY-SCANNER] Syncing session ${sessionId.slice(0, 8)}... (${alreadySynced ? 'update' : 'new'})`);

    const syncResult = await syncSessionToApi(session, syncStatus.teamId, token);

    if (syncResult.success) {
      markSynced(sessionId, session.planContent);

      if (syncResult.action === 'insert') {
        result.synced++;
        mcpLog(`[ANTIGRAVITY-SCANNER] Inserted memory ${syncResult.memoryId?.slice(0, 8)}...`);
      } else if (syncResult.action === 'update') {
        result.updated++;
        mcpLog(`[ANTIGRAVITY-SCANNER] Updated memory ${syncResult.memoryId?.slice(0, 8)}...`);
      } else {
        result.skipped++;
        mcpLog(`[ANTIGRAVITY-SCANNER] Skipped (no extractable content)`);
      }
    } else {
      result.failed++;
      result.errors.push(`Session ${sessionId.slice(0, 8)}: ${syncResult.error}`);
      mcpLog(`[ANTIGRAVITY-SCANNER] Failed: ${syncResult.error}`);
    }
  }

  // Prune old entries periodically
  pruneOldEntries();

  mcpLog(`[ANTIGRAVITY-SCANNER] Scan complete: scanned=${result.scanned}, synced=${result.synced}, updated=${result.updated}, skipped=${result.skipped}, failed=${result.failed}`);
  return result;
}

// ─────────────────────────────────────────────────────────────
// Scanner Control
// ─────────────────────────────────────────────────────────────

/**
 * Start the periodic scanner
 */
export function startScanner(): void {
  if (scannerInterval) {
    mcpLog('[ANTIGRAVITY-SCANNER] Scanner already running');
    return;
  }

  mcpLog('[ANTIGRAVITY-SCANNER] Starting periodic scanner (3 min interval)');

  // Run immediately
  scanOnce().catch(err => {
    mcpLog(`[ANTIGRAVITY-SCANNER] Initial scan error: ${err}`);
  });

  // Then run periodically
  scannerInterval = setInterval(() => {
    scanOnce().catch(err => {
      mcpLog(`[ANTIGRAVITY-SCANNER] Scan error: ${err}`);
    });
  }, SCAN_INTERVAL_MS);
}

/**
 * Stop the periodic scanner
 */
export function stopScanner(): void {
  if (scannerInterval) {
    clearInterval(scannerInterval);
    scannerInterval = null;
    mcpLog('[ANTIGRAVITY-SCANNER] Scanner stopped');
  }
}

/**
 * Check if scanner is running
 */
export function isScannerRunning(): boolean {
  return scannerInterval !== null;
}

