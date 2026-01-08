// Antigravity Session Parser
// Reads plan files from ~/.gemini/antigravity/brain/
// and file tracking from ~/.gemini/antigravity/code_tracker/

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { homedir } from 'os';
import { join, basename } from 'path';

const ANTIGRAVITY_DIR = join(homedir(), '.gemini', 'antigravity');
const BRAIN_DIR = join(ANTIGRAVITY_DIR, 'brain');
const CODE_TRACKER_DIR = join(ANTIGRAVITY_DIR, 'code_tracker', 'active');
const MCP_CONFIG_PATH = join(ANTIGRAVITY_DIR, 'mcp_config.json');

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

export interface AntigravitySession {
  sessionId: string;
  projectPath: string;
  linkedCommit: string | null;
  title: string;
  metadataSummary: string;
  planContent: string;
  taskContent: string;
  filesTouched: string[];
  completionStatus: 'complete' | 'partial';
  updatedAt: string;
}

interface MetadataJson {
  artifactType?: string;
  summary?: string;
  updatedAt?: string;
  version?: string;
}

// ─────────────────────────────────────────────────────────────
// Directory Checks
// ─────────────────────────────────────────────────────────────

export function antigravityExists(): boolean {
  return existsSync(BRAIN_DIR);
}

export function isAntigravityConfigured(): boolean {
  if (!existsSync(MCP_CONFIG_PATH)) return false;
  try {
    const config = JSON.parse(readFileSync(MCP_CONFIG_PATH, 'utf-8')) as { mcpServers?: { grov?: unknown } };
    return !!config.mcpServers?.grov;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────
// Session Discovery
// ─────────────────────────────────────────────────────────────

/**
 * Get all session UUIDs from the brain folder
 */
export function getAllSessionIds(): string[] {
  if (!existsSync(BRAIN_DIR)) return [];

  try {
    return readdirSync(BRAIN_DIR)
      .filter(name => {
        const path = join(BRAIN_DIR, name);
        // Must be a directory and look like a UUID
        return statSync(path).isDirectory() && isValidUuid(name);
      });
  } catch {
    return [];
  }
}

/**
 * Check if string looks like a UUID
 */
function isValidUuid(str: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
}

// ─────────────────────────────────────────────────────────────
// File Reading Helpers
// ─────────────────────────────────────────────────────────────

function readTextFile(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}

function readJsonFile<T>(path: string): T | null {
  const content = readTextFile(path);
  if (!content) return null;
  try {
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// Task.md Parsing
// ─────────────────────────────────────────────────────────────

interface TaskParsed {
  title: string;
  completionStatus: 'complete' | 'partial';
  content: string;
}

function parseTaskMd(content: string): TaskParsed {
  const lines = content.split('\n');
  
  // Extract title from first heading
  let title = '';
  for (const line of lines) {
    if (line.startsWith('# ')) {
      title = line.substring(2).trim();
      break;
    }
  }
  
  // Count checkboxes for completion status
  const checkedCount = (content.match(/- \[x\]/gi) || []).length;
  const uncheckedCount = (content.match(/- \[ \]/g) || []).length;
  const totalBoxes = checkedCount + uncheckedCount;
  
  const completionStatus: 'complete' | 'partial' = 
    totalBoxes === 0 || checkedCount === totalBoxes ? 'complete' : 'partial';
  
  return {
    title: title || 'Untitled Task',
    completionStatus,
    content,
  };
}

// ─────────────────────────────────────────────────────────────
// Implementation Plan Parsing
// ─────────────────────────────────────────────────────────────

/**
 * Extract file paths from [MODIFY] markers in implementation plan
 */
function extractFilesFromPlan(content: string): string[] {
  const files: string[] = [];
  
  // Match [MODIFY] [filename](file://...) patterns
  const modifyRegex = /\[MODIFY\]\s*\[([^\]]+)\]/g;
  let match;
  while ((match = modifyRegex.exec(content)) !== null) {
    files.push(match[1]);
  }
  
  // Also match file:// URLs and extract filenames
  const fileUrlRegex = /file:\/\/[^\s\)]+\/([^\/\s\)]+\.[a-z]+)/gi;
  while ((match = fileUrlRegex.exec(content)) !== null) {
    const filename = match[1];
    if (!files.includes(filename)) {
      files.push(filename);
    }
  }
  
  return files;
}

// ─────────────────────────────────────────────────────────────
// Code Tracker Parsing
// ─────────────────────────────────────────────────────────────

interface CodeTrackerInfo {
  projectPath: string;
  linkedCommit: string | null;
  filesTouched: string[];
}

/**
 * Parse code_tracker/active/ folder for project and files
 * Folder format: {ProjectName}_{commitHash}/
 * File format: {hash}_{filename}
 */
function parseCodeTracker(): CodeTrackerInfo[] {
  if (!existsSync(CODE_TRACKER_DIR)) return [];
  
  const results: CodeTrackerInfo[] = [];
  
  try {
    const projectFolders = readdirSync(CODE_TRACKER_DIR);
    
    for (const folder of projectFolders) {
      const folderPath = join(CODE_TRACKER_DIR, folder);
      if (!statSync(folderPath).isDirectory()) continue;
      
      // Parse folder name: ProjectName_commitHash
      const lastUnderscore = folder.lastIndexOf('_');
      if (lastUnderscore === -1) continue;
      
      const projectPath = folder.substring(0, lastUnderscore);
      const linkedCommit = folder.substring(lastUnderscore + 1);
      
      // Get files in folder
      const files = readdirSync(folderPath);
      const filesTouched: string[] = [];
      
      for (const file of files) {
        // File format: {hash}_{filename}
        const underscoreIdx = file.indexOf('_');
        if (underscoreIdx > 0) {
          const filename = file.substring(underscoreIdx + 1);
          filesTouched.push(filename);
        }
      }
      
      results.push({
        projectPath,
        linkedCommit: linkedCommit || null,
        filesTouched,
      });
    }
  } catch {
    // Ignore errors
  }
  
  return results;
}

/**
 * Find the most recent code tracker entry (by modification time)
 */
function getMostRecentCodeTracker(): CodeTrackerInfo | null {
  if (!existsSync(CODE_TRACKER_DIR)) return null;
  
  try {
    const folders = readdirSync(CODE_TRACKER_DIR)
      .map(name => ({
        name,
        path: join(CODE_TRACKER_DIR, name),
      }))
      .filter(f => statSync(f.path).isDirectory())
      .map(f => ({
        ...f,
        mtime: statSync(f.path).mtime.getTime(),
      }))
      .sort((a, b) => b.mtime - a.mtime);
    
    if (folders.length === 0) return null;
    
    const mostRecent = folders[0];
    const lastUnderscore = mostRecent.name.lastIndexOf('_');
    if (lastUnderscore === -1) return null;
    
    const projectPath = mostRecent.name.substring(0, lastUnderscore);
    const linkedCommit = mostRecent.name.substring(lastUnderscore + 1);
    
    const files = readdirSync(mostRecent.path);
    const filesTouched: string[] = [];
    
    for (const file of files) {
      const underscoreIdx = file.indexOf('_');
      if (underscoreIdx > 0) {
        filesTouched.push(file.substring(underscoreIdx + 1));
      }
    }
    
    return { projectPath, linkedCommit, filesTouched };
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// Session Parsing
// ─────────────────────────────────────────────────────────────

/**
 * Parse a single session by UUID
 */
export function parseSession(sessionId: string): AntigravitySession | null {
  const sessionDir = join(BRAIN_DIR, sessionId);
  if (!existsSync(sessionDir)) return null;
  
  // Read task.md
  const taskContent = readTextFile(join(sessionDir, 'task.md'));
  if (!taskContent) return null; // No task = skip
  
  const taskParsed = parseTaskMd(taskContent);
  
  // Read implementation_plan.md (optional)
  const planContent = readTextFile(join(sessionDir, 'implementation_plan.md')) || '';
  
  // Read metadata files
  const taskMetadata = readJsonFile<MetadataJson>(join(sessionDir, 'task.md.metadata.json'));
  const planMetadata = readJsonFile<MetadataJson>(join(sessionDir, 'implementation_plan.md.metadata.json'));
  
  // Prefer plan metadata summary, fall back to task metadata
  const metadataSummary = planMetadata?.summary || taskMetadata?.summary || taskParsed.title;
  const updatedAt = planMetadata?.updatedAt || taskMetadata?.updatedAt || new Date().toISOString();
  
  // Get files from plan content
  const filesFromPlan = extractFilesFromPlan(planContent);
  
  // Get files from code tracker (use most recent as approximation)
  const codeTracker = getMostRecentCodeTracker();
  
  // Merge files, prefer code tracker
  const allFiles = new Set<string>([
    ...(codeTracker?.filesTouched || []),
    ...filesFromPlan,
  ]);
  
  return {
    sessionId,
    projectPath: codeTracker?.projectPath || 'unknown',
    linkedCommit: codeTracker?.linkedCommit || null,
    title: taskParsed.title,
    metadataSummary,
    planContent,
    taskContent: taskParsed.content,
    filesTouched: Array.from(allFiles),
    completionStatus: taskParsed.completionStatus,
    updatedAt,
  };
}

/**
 * Get sessions sorted by updatedAt (most recent first)
 */
export function getSessionsSortedByDate(): AntigravitySession[] {
  const sessionIds = getAllSessionIds();
  const sessions: AntigravitySession[] = [];
  
  for (const id of sessionIds) {
    const session = parseSession(id);
    if (session) {
      sessions.push(session);
    }
  }
  
  // Sort by updatedAt descending
  sessions.sort((a, b) => {
    const dateA = new Date(a.updatedAt).getTime();
    const dateB = new Date(b.updatedAt).getTime();
    return dateB - dateA;
  });
  
  return sessions;
}

