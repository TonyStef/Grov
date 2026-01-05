// Read messages from Cursor SQLite
// Location varies by OS:
//   Linux:   ~/.config/Cursor/User/globalStorage/state.vscdb
//   macOS:   ~/Library/Application Support/Cursor/User/globalStorage/state.vscdb
//   Windows: %APPDATA%/Cursor/User/globalStorage/state.vscdb

import Database from 'better-sqlite3';
import { homedir, platform } from 'os';
import { join } from 'path';
import { existsSync } from 'fs';
import { mcpLog } from '../logger.js';

function getCursorDbPath(): string {
  const home = homedir();

  switch (platform()) {
    case 'darwin':
      return join(home, 'Library/Application Support/Cursor/User/globalStorage/state.vscdb');
    case 'win32':
      return join(process.env.APPDATA || join(home, 'AppData/Roaming'), 'Cursor/User/globalStorage/state.vscdb');
    default:
      return join(home, '.config/Cursor/User/globalStorage/state.vscdb');
  }
}

const CURSOR_DB_PATH = getCursorDbPath();
const TABLE = 'cursorDiskKV';

export interface ToolCall {
  name: string;
  params: Record<string, unknown>;
}

export interface ComposerData {
  composerId: string;
  projectPath: string;
  createdAt: number;
}

export interface AggregatedAssistant {
  composerId: string;
  usageUuid: string;
  unifiedMode: 1 | 2 | 5;
  text: string;
  thinking: string;
  toolCalls: ToolCall[];
  bubbleCount: number;
}

export interface ConversationPair {
  user: {
    text: string;
    timestamp: number;
  };
  assistant: AggregatedAssistant;
}

function getDb(): Database.Database | null {
  if (!existsSync(CURSOR_DB_PATH)) return null;
  try {
    return new Database(CURSOR_DB_PATH, { readonly: true });
  } catch {
    return null;
  }
}

function getValue(db: Database.Database, key: string): unknown | null {
  const row = db.prepare(`SELECT value FROM ${TABLE} WHERE key = ?`).get(key) as { value: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.value);
  } catch {
    return null;
  }
}

export function getLatestComposerId(): string | null {
  const db = getDb();
  if (!db) return null;

  try {
    // Get all composer keys with their createdAt
    const rows = db.prepare(`SELECT key FROM ${TABLE} WHERE key LIKE 'composerData:%'`).all() as { key: string }[];

    mcpLog(`[getLatestComposerId] Found ${rows.length} composers, checking for bubbles...`);

    // Build list of composers with their timestamps
    const composers: Array<{ id: string; createdAt: number }> = [];
    for (const row of rows) {
      const composerId = row.key.replace('composerData:', '');
      const data = getValue(db, row.key) as { createdAt?: number } | null;
      if (data?.createdAt) {
        composers.push({ id: composerId, createdAt: data.createdAt });
      }
    }

    // Sort by createdAt descending (newest first)
    composers.sort((a, b) => b.createdAt - a.createdAt);

    // Find first composer that has at least one bubble
    for (const composer of composers) {
      const bubbleCount = db.prepare(
        `SELECT COUNT(*) as count FROM ${TABLE} WHERE key LIKE ?`
      ).get(`bubbleId:${composer.id}:%`) as { count: number };

      if (bubbleCount.count > 0) {
        mcpLog(`[getLatestComposerId] Selected ${composer.id.substring(0, 8)}... (${bubbleCount.count} bubbles)`);
        return composer.id;
      } else {
        mcpLog(`[getLatestComposerId] Skipping ${composer.id.substring(0, 8)}... (0 bubbles)`);
      }
    }

    mcpLog(`[getLatestComposerId] No composer with bubbles found`);
    return null;
  } finally {
    db.close();
  }
}

export function getComposerData(composerId: string): ComposerData | null {
  const db = getDb();
  if (!db) return null;

  try {
    const data = getValue(db, `composerData:${composerId}`) as Record<string, unknown> | null;
    if (!data) return null;

    let projectPath = '';

    // Primary: Extract from messageRequestContext.ideEditorsState
    // Find a user bubble (type=1) to get its bubbleId
    const userBubble = db.prepare(`
      SELECT json_extract(value, '$.bubbleId') as bubbleId
      FROM ${TABLE}
      WHERE key LIKE ? AND json_extract(value, '$.type') = 1
      LIMIT 1
    `).get(`bubbleId:${composerId}:%`) as { bubbleId: string } | undefined;

    if (userBubble?.bubbleId) {
      const msgCtx = getValue(db, `messageRequestContext:${composerId}:${userBubble.bubbleId}`) as Record<string, unknown> | null;
      if (msgCtx?.ideEditorsState && typeof msgCtx.ideEditorsState === 'string') {
        try {
          const ide = JSON.parse(msgCtx.ideEditorsState) as {
            visibleFiles?: Array<{ relativePath?: string; absolutePath?: string }>;
          };
          const file = ide.visibleFiles?.[0];
          if (file?.relativePath && file?.absolutePath && file.absolutePath.endsWith(file.relativePath)) {
            projectPath = file.absolutePath.slice(0, -(file.relativePath.length + 1));
            mcpLog(`[getComposerData] Project from ideEditorsState: ${projectPath}`);
          }
        } catch {
          // ignore parse errors
        }
      }
    }

    // Fallback: Extract from toolFormerData file paths
    if (!projectPath) {
      const toolBubbles = db.prepare(`
        SELECT json_extract(value, '$.toolFormerData') as toolData
        FROM ${TABLE}
        WHERE key LIKE ? AND json_extract(value, '$.toolFormerData') IS NOT NULL
        LIMIT 5
      `).all(`bubbleId:${composerId}:%`) as Array<{ toolData: string }>;

      for (const row of toolBubbles) {
        if (projectPath) break;
        try {
          const toolData = JSON.parse(row.toolData) as { params?: string };
          if (toolData.params) {
            const params = JSON.parse(toolData.params) as Record<string, unknown>;
            // Look for file paths in common param names
            const filePath = params.targetFile || params.relativeWorkspacePath || params.file_path || params.path;
            if (typeof filePath === 'string' && filePath.startsWith('/')) {
              // Extract project root from absolute path (assume src/, lib/, etc. are inside project)
              const match = filePath.match(/^(\/[^/]+(?:\/[^/]+)*?)\/(?:src|lib|test|tests|app|packages|node_modules)\//);
              if (match) {
                projectPath = match[1];
                mcpLog(`[getComposerData] Project from toolFormerData: ${projectPath}`);
                break;
              }
            }
          }
        } catch {
          // ignore parse errors
        }
      }
    }

    return {
      composerId,
      projectPath,
      createdAt: typeof data.createdAt === 'number' ? data.createdAt : 0,
    };
  } finally {
    db.close();
  }
}

export function getLatestPromptId(composerId: string): string | null {
  const db = getDb();
  if (!db) return null;

  try {
    // Get all bubbles for this composer with their usageUuid and content info
    const rows = db.prepare(`
      SELECT
        key,
        json_extract(value, '$.usageUuid') as usageUuid,
        json_extract(value, '$.requestId') as requestId,
        json_extract(value, '$.type') as type,
        json_extract(value, '$.text') as text,
        json_extract(value, '$.thinking.text') as thinking,
        json_extract(value, '$.createdAt') as createdAt
      FROM ${TABLE}
      WHERE key LIKE ?
      ORDER BY json_extract(value, '$.createdAt') DESC
    `).all(`bubbleId:${composerId}:%`) as Array<{
      key: string;
      usageUuid: string | null;
      requestId: string | null;
      type: number;
      text: string | null;
      thinking: string | null;
      createdAt: string | null;
    }>;

    mcpLog(`[getLatestPromptId] Composer ${composerId.substring(0, 8)}: found ${rows.length} bubbles total`);

    if (rows.length === 0) return null;

    // First: collect all usageUuids that have a user bubble (type=1)
    // These are the only valid ones we can use
    const uuidsWithUserBubble = new Set<string>();
    for (const row of rows) {
      if (row.type === 1 && row.requestId) {
        uuidsWithUserBubble.add(row.requestId);
      }
    }
    mcpLog(`[getLatestPromptId] usageUuids with user bubble: ${uuidsWithUserBubble.size}`);

    // Group by usageUuid, track latest timestamp and whether it has content
    const promptMap = new Map<string, { maxTimestamp: number; hasContent: boolean }>();

    for (const row of rows) {
      // usageUuid is on assistant messages, requestId is on user messages (same value)
      const uuid = row.usageUuid || row.requestId;
      if (!uuid) continue;

      // Skip usageUuids that don't have a user bubble (continuations)
      if (!uuidsWithUserBubble.has(uuid)) continue;

      const hasContent = Boolean((row.text && row.text.length > 0) || (row.thinking && row.thinking.length > 0));
      const timestamp = row.createdAt ? parseInt(row.createdAt, 10) : 0;

      const existing = promptMap.get(uuid);
      if (!existing) {
        promptMap.set(uuid, { maxTimestamp: timestamp, hasContent });
      } else {
        if (timestamp > existing.maxTimestamp) {
          existing.maxTimestamp = timestamp;
        }
        if (hasContent) {
          existing.hasContent = true;
        }
      }
    }

    mcpLog(`[getLatestPromptId] Distinct usageUuids (with user bubble): ${promptMap.size}`);

    // Find the latest usageUuid that has content
    let latestUuid: string | null = null;
    let latestTime = 0;

    for (const [uuid, info] of promptMap) {
      if (info.hasContent && info.maxTimestamp > latestTime) {
        latestTime = info.maxTimestamp;
        latestUuid = uuid;
      }
    }

    if (latestUuid) {
      mcpLog(`[getLatestPromptId] Latest with content: ${latestUuid.substring(0, 8)}... (timestamp: ${latestTime})`);
    } else {
      mcpLog(`[getLatestPromptId] No valid prompt found with content`);
    }

    return latestUuid;
  } finally {
    db.close();
  }
}

export function getConversationPair(composerId: string, usageUuid: string): ConversationPair | null {
  const db = getDb();
  if (!db) return null;

  try {
    // Get all bubbles for this usageUuid
    const rows = db.prepare(`
      SELECT
        json_extract(value, '$.type') as type,
        json_extract(value, '$.usageUuid') as usageUuid,
        json_extract(value, '$.requestId') as requestId,
        json_extract(value, '$.text') as text,
        json_extract(value, '$.thinking.text') as thinking,
        json_extract(value, '$.unifiedMode') as unifiedMode,
        json_extract(value, '$.createdAt') as createdAt,
        json_extract(value, '$.toolFormerData') as toolFormerData
      FROM ${TABLE}
      WHERE key LIKE ?
      ORDER BY json_extract(value, '$.createdAt') ASC
    `).all(`bubbleId:${composerId}:%`) as Array<{
      type: number;
      usageUuid: string | null;
      requestId: string | null;
      text: string | null;
      thinking: string | null;
      unifiedMode: number | null;
      createdAt: string | null;
      toolFormerData: string | null;
    }>;

    // Filter to only bubbles matching our usageUuid
    mcpLog(`[getConversationPair] Total rows from query: ${rows.length}, filtering for usageUuid=${usageUuid.substring(0, 8)}...`);
    for (const r of rows) {
      mcpLog(`[getConversationPair] Row: type=${r.type}, usageUuid=${r.usageUuid?.substring(0, 8) || 'null'}, requestId=${r.requestId?.substring(0, 8) || 'null'}, hasTool=${r.toolFormerData ? 'yes' : 'no'}`);
    }
    const matchingBubbles = rows.filter(r => r.usageUuid === usageUuid || r.requestId === usageUuid);

    mcpLog(`[getConversationPair] usageUuid=${usageUuid.substring(0, 8)}...: found ${matchingBubbles.length} bubbles`);

    if (matchingBubbles.length === 0) return null;

    // Find user bubble (type=1)
    const userBubble = matchingBubbles.find(r => r.type === 1);
    if (!userBubble) {
      mcpLog(`[getConversationPair] No user bubble found`);
      return null;
    }

    // Get assistant bubbles (type=2)
    const assistantBubbles = matchingBubbles.filter(r => r.type === 2);

    // Debug: log each bubble's fields
    for (let i = 0; i < assistantBubbles.length; i++) {
      const b = assistantBubbles[i];
      mcpLog(`[getConversationPair] Bubble ${i}: text=${b.text?.length || 0}, thinking=${b.thinking?.length || 0}, hasTool=${b.toolFormerData ? 'yes' : 'no'}`);
    }

    // Aggregate thinking from all bubbles
    const thinkingParts: string[] = [];
    let withThinking = 0;
    let withText = 0;

    for (const bubble of assistantBubbles) {
      if (bubble.thinking && bubble.thinking.length > 0) {
        thinkingParts.push(bubble.thinking);
        withThinking++;
      }
    }

    // Get text from the last bubble that has text
    let finalText = '';
    for (let i = assistantBubbles.length - 1; i >= 0; i--) {
      if (assistantBubbles[i].text && assistantBubbles[i].text!.length > 0) {
        finalText = assistantBubbles[i].text!;
        withText++;
        break;
      }
    }

    // Aggregate tool calls from all bubbles (toolFormerData is a JSON object with name/params)
    const allToolCalls: ToolCall[] = [];
    for (const bubble of assistantBubbles) {
      if (bubble.toolFormerData) {
        try {
          const toolData = JSON.parse(bubble.toolFormerData) as { name?: string; params?: string };
          if (toolData.name) {
            let params: Record<string, unknown> = {};
            if (toolData.params) {
              try {
                params = JSON.parse(toolData.params);
              } catch {
                // params might not be valid JSON
              }
            }
            allToolCalls.push({
              name: toolData.name,
              params,
            });
            mcpLog(`[getConversationPair] Tool: ${toolData.name}, params keys: ${Object.keys(params).join(',')}`);
          }
        } catch {
          // ignore parse errors
        }
      }
    }

    // Get unifiedMode from first assistant bubble
    const unifiedMode = assistantBubbles[0]?.unifiedMode;
    const mode: 1 | 2 | 5 = unifiedMode === 1 ? 1 : unifiedMode === 5 ? 5 : 2;

    const aggregatedThinking = thinkingParts.join('\n\n');

    mcpLog(`[getConversationPair] User: "${userBubble.text?.substring(0, 50)}..." (${userBubble.text?.length || 0} chars)`);
    mcpLog(`[getConversationPair] Assistant bubbles: ${assistantBubbles.length} total, ${withThinking} with thinking, ${withText > 0 ? 1 : 0} with text`);
    mcpLog(`[getConversationPair] Aggregated: thinking=${aggregatedThinking.length} chars, text=${finalText.length} chars, toolCalls=${allToolCalls.length}`);

    return {
      user: {
        text: userBubble.text || '',
        timestamp: userBubble.createdAt ? parseInt(userBubble.createdAt, 10) : 0,
      },
      assistant: {
        composerId,
        usageUuid,
        unifiedMode: mode,
        text: finalText,
        thinking: aggregatedThinking,
        toolCalls: allToolCalls,
        bubbleCount: assistantBubbles.length,
      },
    };
  } finally {
    db.close();
  }
}

export function dbExists(): boolean {
  return existsSync(CURSOR_DB_PATH);
}

/**
 * Get current workspace from Cursor's recently opened list.
 * Index 0 = most recently accessed = current workspace.
 */
export function getCurrentWorkspace(): string | null {
  const db = getDb();
  if (!db) return null;

  try {
    const row = db.prepare(`SELECT value FROM ItemTable WHERE key = ?`).get('history.recentlyOpenedPathsList') as { value: string } | undefined;
    if (!row) return null;

    const data = JSON.parse(row.value) as { entries?: Array<{ folderUri?: string }> };
    const folderUri = data.entries?.[0]?.folderUri;

    if (!folderUri) return null;

    // Remove file:// prefix
    const projectPath = folderUri.replace('file://', '');
    mcpLog(`[getCurrentWorkspace] Current workspace: ${projectPath}`);
    return projectPath;
  } catch (err) {
    mcpLog(`[getCurrentWorkspace] Error: ${err}`);
    return null;
  } finally {
    db.close();
  }
}
