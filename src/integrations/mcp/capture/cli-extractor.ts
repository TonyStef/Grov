// CLI Extractor - Parse SQLite blobs, identify turns, extract conversation data
// Cursor CLI stores conversations in protobuf-like blobs with embedded JSON

import Database from 'better-sqlite3';
import { findAllCLIDatabases } from './cli-watcher.js';
import { isAlreadyCaptured, markAsCaptured, cleanupOldChats } from './cli-synced.js';
import { transformToApiFormat, postToApi } from './cli-transform.js';

export interface Turn {
  usageUuid: string;
  agentId: string;
  userPrompt: string;
  assistantTexts: string[];
  reasoningBlocks: string[];
  toolCalls: Array<{ toolName: string; args: Record<string, unknown> }>;
  projectPath: string;
  model: string;
  isComplete: boolean;
}

interface MetaData {
  agentId: string;
  latestRootBlobId: string;
  name: string;
  mode: string;
  lastUsedModel: string;
}

interface ContentBlock {
  type: 'text' | 'tool-call' | 'reasoning' | 'tool-result';
  text?: string;
  toolName?: string;
  args?: Record<string, unknown>;
}

interface MessageData {
  role: 'user' | 'assistant' | 'system';
  content: ContentBlock[];
  requestId?: string;
}

/**
 * Main polling function - captures all completed turns from all CLI databases
 */
export async function pollAndCaptureAll(): Promise<void> {
  const databases = findAllCLIDatabases();
  if (databases.length === 0) return;

  for (const { dbPath, agentId } of databases) {
    try {
      await captureFromDatabase(dbPath, agentId);
    } catch {
      // Ignore individual database errors
    }
  }

  cleanupOldChats();
}

/**
 * Capture turns from a single CLI database
 */
async function captureFromDatabase(dbPath: string, agentId: string): Promise<void> {
  const db = new Database(dbPath, { readonly: true });

  try {
    const meta = getMetaData(db);
    if (!meta) return;

    const orderedBlobIds = parseRootBlob(db, meta.latestRootBlobId);
    if (orderedBlobIds.length === 0) return;

    const turns = identifyAllTurns(db, orderedBlobIds, meta);
    const completedTurns = turns.filter(turn => turn.isComplete);
    const newTurns = completedTurns.filter(turn =>
      !isAlreadyCaptured(meta.agentId, turn.usageUuid)
    );

    if (newTurns.length === 0) return;

    for (const turn of newTurns) {
      try {
        const success = await postToApi(transformToApiFormat(turn, meta));
        if (success) {
          markAsCaptured(meta.agentId, turn.usageUuid);
        }
      } catch {
        // Ignore individual capture errors
      }
    }
  } finally {
    db.close();
  }
}

/**
 * Get meta data from CLI database
 */
function getMetaData(db: Database.Database): MetaData | null {
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key='0'").get() as { value: string } | undefined;
    if (!row) return null;

    const json = Buffer.from(row.value, 'hex').toString('utf8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/**
 * Parse root blob to get ordered list of child blob IDs
 * Root blob contains protobuf-encoded list with 0a20 markers followed by 32-byte hashes
 */
function parseRootBlob(db: Database.Database, rootId: string): string[] {
  try {
    const row = db.prepare("SELECT data FROM blobs WHERE id=?").get(rootId) as { data: Buffer } | undefined;
    if (!row) return [];

    const data = row.data;
    const ids: string[] = [];

    for (let i = 0; i < data.length - 33; i++) {
      if (data[i] === 0x0a && data[i + 1] === 0x20) {
        const hash = data.slice(i + 2, i + 34).toString('hex');
        ids.push(hash);
        i += 33;
      }
    }

    return ids;
  } catch {
    return [];
  }
}

/**
 * Raw blob JSON structure from CLI SQLite
 */
interface RawBlobJson {
  role?: 'user' | 'assistant' | 'system' | 'tool';
  id?: string;
  content?: string | RawContentBlock[];
  providerOptions?: {
    cursor?: {
      requestId?: string;
    };
  };
}

interface RawContentBlock {
  type: string;
  text?: string;
  toolName?: string;
  toolCallId?: string;
  args?: Record<string, unknown>;
}

/**
 * Parse a single blob to extract message data
 * CLI blobs are JSON with structure: {"role":"...", "content": string | ContentBlock[]}
 */
function parseBlob(db: Database.Database, blobId: string): MessageData | null {
  try {
    const row = db.prepare("SELECT data FROM blobs WHERE id=?").get(blobId) as { data: Buffer } | undefined;
    if (!row) return null;

    const dataStr = row.data.toString('utf8');

    // Skip non-JSON blobs (protobuf/binary)
    if (!dataStr.startsWith('{')) return null;

    let json: RawBlobJson;
    try {
      json = JSON.parse(dataStr);
    } catch {
      return null; // Not valid JSON
    }

    // Must have role (user, assistant, system - skip 'tool')
    if (!json.role || json.role === 'tool') return null;
    if (json.role !== 'user' && json.role !== 'assistant' && json.role !== 'system') return null;

    const content: ContentBlock[] = [];

    // Handle content field - can be string or array
    if (typeof json.content === 'string') {
      // System/context messages have content as string
      content.push({ type: 'text', text: json.content });
    } else if (Array.isArray(json.content)) {
      // User queries and assistant responses have content as array
      for (const block of json.content) {
        if (block.type === 'text' && block.text) {
          content.push({ type: 'text', text: block.text });
        } else if (block.type === 'reasoning' && block.text) {
          content.push({ type: 'reasoning', text: block.text });
        } else if (block.type === 'tool-call' && block.toolName) {
          content.push({
            type: 'tool-call',
            toolName: block.toolName,
            args: block.args || {}
          });
        }
      }
    }

    // Extract requestId from providerOptions
    const requestId = json.providerOptions?.cursor?.requestId;

    return {
      role: json.role,
      content,
      requestId
    };
  } catch {
    return null;
  }
}

/**
 * Identify all turns from ordered blob IDs
 * A turn starts with a user message and includes all following assistant messages
 */
function identifyAllTurns(db: Database.Database, orderedBlobIds: string[], meta: MetaData): Turn[] {
  const turns: Turn[] = [];
  let currentTurn: Partial<Turn> | null = null;

  for (const blobId of orderedBlobIds) {
    const message = parseBlob(db, blobId);
    if (!message) continue;

    if (message.role === 'user' && hasTextContent(message)) {
      // New turn starts
      if (currentTurn && currentTurn.usageUuid) {
        // Finalize previous turn
        currentTurn.isComplete = isTurnComplete(currentTurn);
        turns.push(currentTurn as Turn);
      }

      // Start new turn
      currentTurn = {
        usageUuid: message.requestId || blobId,
        agentId: meta.agentId,
        userPrompt: extractTextContent(message),
        assistantTexts: [],
        reasoningBlocks: [],
        toolCalls: [],
        projectPath: extractProjectPath(message) || '',
        model: meta.lastUsedModel || 'unknown',
        isComplete: false
      };
    } else if (currentTurn && message.role === 'assistant') {
      // Add to current turn
      for (const block of message.content) {
        if (block.type === 'text' && block.text) {
          currentTurn.assistantTexts!.push(block.text);
        } else if (block.type === 'reasoning' && block.text) {
          currentTurn.reasoningBlocks!.push(block.text);
        } else if (block.type === 'tool-call' && block.toolName) {
          currentTurn.toolCalls!.push({
            toolName: block.toolName,
            args: block.args || {}
          });
        }
      }
    }
  }

  // Don't forget last turn
  if (currentTurn && currentTurn.usageUuid) {
    currentTurn.isComplete = isTurnComplete(currentTurn);
    turns.push(currentTurn as Turn);
  }

  return turns;
}

/**
 * Check if message has text content
 */
function hasTextContent(message: MessageData): boolean {
  return message.content.some(c => c.type === 'text' && c.text && c.text.length > 0);
}

/**
 * Extract text content from message
 */
function extractTextContent(message: MessageData): string {
  return message.content
    .filter(c => c.type === 'text' && c.text)
    .map(c => c.text!)
    .join('\n');
}

/**
 * Extract project path from user context message
 * Looks for "Workspace Path: /path/to/project" pattern
 */
function extractProjectPath(message: MessageData): string | null {
  const fullText = message.content
    .filter(c => c.type === 'text' && c.text)
    .map(c => c.text!)
    .join('\n');

  const match = fullText.match(/Workspace Path:\s*([^\n]+)/);
  return match?.[1]?.trim() || null;
}

/**
 * Check if turn is complete
 * Complete = has text response AND no pending tool calls in final state
 *
 * Key insight: By LLM API design, if assistant has text AND wants to call tools,
 * both MUST be in the SAME message. So text without tool-call = turn complete.
 */
function isTurnComplete(turn: Partial<Turn>): boolean {
  // Must have assistant text response
  if (!turn.assistantTexts || turn.assistantTexts.length === 0) {
    return false;
  }

  // If has text, turn is complete (tool calls would be in same message)
  return true;
}
