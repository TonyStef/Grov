// LLM-based extraction using Claude Haiku for reasoning summaries

import Anthropic from '@anthropic-ai/sdk';
import type { ParsedSession } from './jsonl-parser.js';
import type { TaskStatus } from './store.js';

// Extracted reasoning structure
export interface ExtractedReasoning {
  task: string;
  goal: string;
  reasoning_trace: string[];
  files_touched: string[];
  decisions: Array<{ choice: string; reason: string }>;
  constraints: string[];
  status: TaskStatus;
  tags: string[];
}

let client: Anthropic | null = null;

/**
 * Initialize the Anthropic client
 */
function getClient(): Anthropic {
  if (!client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY environment variable is required for LLM extraction');
    }
    client = new Anthropic({ apiKey });
  }
  return client;
}

/**
 * Check if LLM extraction is available (API key set)
 */
export function isLLMAvailable(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

/**
 * Extract structured reasoning from a parsed session using Claude Haiku
 */
export async function extractReasoning(session: ParsedSession): Promise<ExtractedReasoning> {
  const anthropic = getClient();

  // Build session summary for the prompt
  const sessionSummary = buildSessionSummary(session);

  const response = await anthropic.messages.create({
    model: 'claude-3-haiku-20240307',
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content: `Analyze this Claude Code session and extract a structured reasoning summary.

SESSION DATA:
${sessionSummary}

Extract the following as JSON:
{
  "task": "Brief description of what the user was trying to do (1 sentence)",
  "goal": "The underlying goal or problem being solved",
  "reasoning_trace": ["Key reasoning steps taken", "Decisions made and why", "What was investigated"],
  "decisions": [{"choice": "What was decided", "reason": "Why this choice was made"}],
  "constraints": ["Any constraints or requirements discovered"],
  "status": "complete|partial|question|abandoned",
  "tags": ["relevant", "domain", "tags"]
}

Status definitions:
- "complete": Task was finished, implementation done
- "partial": Work started but not finished
- "question": Claude asked a question and is waiting for user response
- "abandoned": User interrupted or moved to different topic

Return ONLY valid JSON, no explanation.`
      }
    ]
  });

  // Parse the response
  const content = response.content[0];
  if (content.type !== 'text') {
    throw new Error('Unexpected response type from Claude');
  }

  try {
    const extracted = JSON.parse(content.text) as Partial<ExtractedReasoning>;

    // Validate and fill defaults
    return {
      task: extracted.task || session.userMessages[0]?.substring(0, 100) || 'Unknown task',
      goal: extracted.goal || extracted.task || 'Unknown goal',
      reasoning_trace: extracted.reasoning_trace || [],
      files_touched: session.filesRead.concat(session.filesWritten),
      decisions: extracted.decisions || [],
      constraints: extracted.constraints || [],
      status: validateStatus(extracted.status),
      tags: extracted.tags || []
    };
  } catch (parseError) {
    // If JSON parsing fails, return basic extraction
    console.error('[grov] Failed to parse LLM response, using fallback');
    return createFallbackExtraction(session);
  }
}

/**
 * Classify just the task status (lighter weight than full extraction)
 */
export async function classifyTaskStatus(session: ParsedSession): Promise<TaskStatus> {
  const anthropic = getClient();

  // Get last few exchanges for classification
  const lastMessages = session.userMessages.slice(-2).join('\n---\n');
  const lastAssistant = session.assistantMessages.slice(-1)[0] || '';

  const response = await anthropic.messages.create({
    model: 'claude-3-haiku-20240307',
    max_tokens: 50,
    messages: [
      {
        role: 'user',
        content: `Classify this conversation state. Return ONLY one word: complete, partial, question, or abandoned.

Last user message(s):
${lastMessages}

Last assistant response (truncated):
${lastAssistant.substring(0, 500)}

Files written: ${session.filesWritten.length}
Files read: ${session.filesRead.length}

Classification:`
      }
    ]
  });

  const content = response.content[0];
  if (content.type !== 'text') {
    return 'partial';
  }

  return validateStatus(content.text.trim().toLowerCase());
}

/**
 * Build a summary of the session for the LLM prompt
 */
function buildSessionSummary(session: ParsedSession): string {
  const lines: string[] = [];

  // User messages
  lines.push('USER MESSAGES:');
  session.userMessages.forEach((msg, i) => {
    lines.push(`[${i + 1}] ${truncate(msg, 300)}`);
  });
  lines.push('');

  // Files touched
  lines.push('FILES READ:');
  session.filesRead.slice(0, 10).forEach(f => lines.push(`  - ${f}`));
  if (session.filesRead.length > 10) {
    lines.push(`  ... and ${session.filesRead.length - 10} more`);
  }
  lines.push('');

  lines.push('FILES WRITTEN/EDITED:');
  session.filesWritten.forEach(f => lines.push(`  - ${f}`));
  lines.push('');

  // Tool usage summary
  lines.push('TOOL USAGE:');
  const toolCounts = session.toolCalls.reduce((acc, t) => {
    acc[t.name] = (acc[t.name] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  Object.entries(toolCounts).forEach(([name, count]) => {
    lines.push(`  - ${name}: ${count}x`);
  });
  lines.push('');

  // Last assistant message (often contains summary/conclusion)
  const lastAssistant = session.assistantMessages[session.assistantMessages.length - 1];
  if (lastAssistant) {
    lines.push('LAST ASSISTANT MESSAGE:');
    lines.push(truncate(lastAssistant, 500));
  }

  return lines.join('\n');
}

/**
 * Create fallback extraction when LLM fails
 */
function createFallbackExtraction(session: ParsedSession): ExtractedReasoning {
  const filesTouched = [...new Set([...session.filesRead, ...session.filesWritten])];

  return {
    task: session.userMessages[0]?.substring(0, 100) || 'Unknown task',
    goal: session.userMessages[0]?.substring(0, 100) || 'Unknown goal',
    reasoning_trace: generateBasicTrace(session),
    files_touched: filesTouched,
    decisions: [],
    constraints: [],
    status: session.filesWritten.length > 0 ? 'complete' : 'partial',
    tags: generateTagsFromFiles(filesTouched)
  };
}

/**
 * Generate basic reasoning trace from tool usage
 */
function generateBasicTrace(session: ParsedSession): string[] {
  const trace: string[] = [];
  const toolCounts = session.toolCalls.reduce((acc, t) => {
    acc[t.name] = (acc[t.name] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  if (toolCounts['Read']) trace.push(`Read ${toolCounts['Read']} files`);
  if (toolCounts['Write']) trace.push(`Wrote ${toolCounts['Write']} files`);
  if (toolCounts['Edit']) trace.push(`Edited ${toolCounts['Edit']} files`);
  if (toolCounts['Grep'] || toolCounts['Glob']) trace.push('Searched codebase');
  if (toolCounts['Bash']) trace.push(`Ran ${toolCounts['Bash']} commands`);

  return trace;
}

/**
 * Generate tags from file paths
 */
function generateTagsFromFiles(files: string[]): string[] {
  const tags = new Set<string>();

  for (const file of files) {
    const parts = file.split('/');
    for (const part of parts) {
      if (part && !part.includes('.') && part !== 'src' && part !== 'lib') {
        tags.add(part.toLowerCase());
      }
    }
    // Common patterns
    if (file.includes('auth')) tags.add('auth');
    if (file.includes('api')) tags.add('api');
    if (file.includes('test')) tags.add('test');
  }

  return [...tags].slice(0, 10);
}

/**
 * Validate and normalize status
 */
function validateStatus(status: string | undefined): TaskStatus {
  const normalized = status?.toLowerCase().trim();
  if (normalized === 'complete' || normalized === 'partial' ||
      normalized === 'question' || normalized === 'abandoned') {
    return normalized;
  }
  return 'partial'; // Default
}

/**
 * Truncate string
 */
function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return str.substring(0, maxLength - 3) + '...';
}
