// LLM-based extraction using OpenAI GPT-3.5-turbo for reasoning summaries
// and Anthropic Claude Haiku for drift detection

import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { config } from 'dotenv';
import { join } from 'path';
import { homedir } from 'os';
import { existsSync } from 'fs';
import type { ParsedSession } from './jsonl-parser.js';
import type { TaskStatus, SessionState, StepRecord } from './store.js';
import { debugLLM } from './debug.js';
import { truncate } from './utils.js';

// Load ~/.grov/.env as fallback for API key
// This allows users to store their API key in a safe location outside any repo
const grovEnvPath = join(homedir(), '.grov', '.env');
if (existsSync(grovEnvPath)) {
  config({ path: grovEnvPath });
}

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

let client: OpenAI | null = null;
let anthropicClient: Anthropic | null = null;

/**
 * Initialize the OpenAI client
 */
function getClient(): OpenAI {
  if (!client) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      // SECURITY: Generic error to avoid confirming API key mechanism exists
      throw new Error('LLM extraction unavailable');
    }
    client = new OpenAI({ apiKey });
  }
  return client;
}

/**
 * Initialize the Anthropic client
 */
function getAnthropicClient(): Anthropic {
  if (!anthropicClient) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY environment variable is required for drift detection');
    }
    anthropicClient = new Anthropic({ apiKey });
  }
  return anthropicClient;
}

/**
 * Check if LLM extraction is available (OpenAI API key set)
 */
export function isLLMAvailable(): boolean {
  return !!process.env.OPENAI_API_KEY;
}

// ============================================
// INTENT EXTRACTION (First prompt analysis)
// Reference: plan_proxy_local.md Section 3.1
// ============================================

export interface ExtractedIntent {
  goal: string;
  expected_scope: string[];
  constraints: string[];
  success_criteria?: string[];  // Optional - hook uses, proxy ignores
  keywords: string[];
}

/**
 * Extract intent from first user prompt using Haiku
 * Called once at session start to populate session_states
 * Falls back to basic extraction if API unavailable (for hook compatibility)
 */
export async function extractIntent(firstPrompt: string): Promise<ExtractedIntent> {
  // Check availability first - allows hook to work without API key
  if (!isIntentExtractionAvailable()) {
    return createFallbackIntent(firstPrompt);
  }

  try {
    const client = getAnthropicClient();

    const prompt = `Analyze this user request and extract structured intent for a coding assistant session.

USER REQUEST:
${firstPrompt.substring(0, 2000)}

Extract as JSON:
{
  "goal": "The main objective in 1-2 sentences",
  "expected_scope": ["list", "of", "files/folders", "likely", "to", "be", "modified"],
  "constraints": ["EXPLICIT restrictions from the user - see examples below"],
  "success_criteria": ["How to know when the task is complete"],
  "keywords": ["relevant", "technical", "terms"]
}

═══════════════════════════════════════════════════════════════
CONSTRAINTS EXTRACTION - BE VERY THOROUGH
═══════════════════════════════════════════════════════════════

Look for NEGATIVE constraints (things NOT to do):
- "NU modifica" / "DON'T modify" / "NEVER change" / "don't touch"
- "NU rula" / "DON'T run" / "NO commands" / "don't execute"
- "fără X" / "without X" / "except X" / "not including"
- "nu scrie cod" / "don't write code" / "just plan"

Look for POSITIVE constraints (things MUST do / ONLY do):
- "ONLY modify X" / "DOAR în X" / "only in folder Y"
- "must use Y" / "trebuie să folosești Y"
- "keep it simple" / "no external dependencies"
- "use TypeScript" / "must be async"

EXAMPLES:
Input: "Fix bug in auth. NU modifica nimic in afara de sandbox/, NU rula comenzi."
Output constraints: ["DO NOT modify files outside sandbox/", "DO NOT run commands"]

Input: "Add feature X. Only use standard library, keep backward compatible."
Output constraints: ["ONLY use standard library", "Keep backward compatible"]

Input: "Analyze code and create plan. Nu scrie cod inca, doar planifica."
Output constraints: ["DO NOT write code yet", "Only create plan/analysis"]

For expected_scope:
- Include file patterns (e.g., "src/auth/", "*.test.ts", "sandbox/")
- Include component/module names mentioned
- Be conservative - only include clearly relevant areas

RESPONSE RULES:
- English only (translate Romanian/other languages to English)
- No emojis
- Valid JSON only
- If no constraints found, return empty array []`;

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 500,
    messages: [{ role: 'user', content: prompt }],
  });

  const content = response.content?.[0];
  if (!content || content.type !== 'text') {
    return createFallbackIntent(firstPrompt);
  }

  try {
    const jsonMatch = content.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return createFallbackIntent(firstPrompt);
    }

    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;

    return {
      goal: typeof parsed.goal === 'string' ? parsed.goal : firstPrompt.substring(0, 200),
      expected_scope: Array.isArray(parsed.expected_scope)
        ? parsed.expected_scope.filter((s): s is string => typeof s === 'string')
        : [],
      constraints: Array.isArray(parsed.constraints)
        ? parsed.constraints.filter((c): c is string => typeof c === 'string')
        : [],
      success_criteria: Array.isArray(parsed.success_criteria)
        ? parsed.success_criteria.filter((s): s is string => typeof s === 'string')
        : [],
      keywords: Array.isArray(parsed.keywords)
        ? parsed.keywords.filter((k): k is string => typeof k === 'string')
        : [],
    };
  } catch {
    return createFallbackIntent(firstPrompt);
  }
  } catch {
    // Outer catch - API errors, network issues, etc.
    return createFallbackIntent(firstPrompt);
  }
}

/**
 * Fallback intent extraction without LLM
 */
function createFallbackIntent(prompt: string): ExtractedIntent {
  // Basic keyword extraction
  const words = prompt.toLowerCase().split(/\s+/);
  const techKeywords = words.filter(w =>
    w.length > 3 &&
    /^[a-z]+$/.test(w) &&
    !['this', 'that', 'with', 'from', 'have', 'will', 'would', 'could', 'should'].includes(w)
  );

  // Extract file patterns
  const filePatterns = prompt.match(/[\w\/.-]+\.(ts|js|tsx|jsx|py|go|rs|java|css|html|md)/g) || [];

  return {
    goal: prompt.substring(0, 200),
    expected_scope: [...new Set(filePatterns)].slice(0, 5),
    constraints: [],
    success_criteria: [],
    keywords: [...new Set(techKeywords)].slice(0, 10),
  };
}

/**
 * Check if intent extraction is available
 */
export function isIntentExtractionAvailable(): boolean {
  return !!(process.env.ANTHROPIC_API_KEY || process.env.GROV_API_KEY);
}

/**
 * Check if Anthropic API is available (for drift detection)
 */
export function isAnthropicAvailable(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

/**
 * Get the drift model to use (from env or default)
 */
export function getDriftModel(): string {
  return process.env.GROV_DRIFT_MODEL || 'claude-haiku-4-5';
}

/**
 * Extract structured reasoning from a parsed session using GPT-3.5-turbo
 */
export async function extractReasoning(session: ParsedSession): Promise<ExtractedReasoning> {
  const openai = getClient();

  // Build session summary for the prompt
  const sessionSummary = buildSessionSummary(session);

  const response = await openai.chat.completions.create({
    model: 'gpt-3.5-turbo',
    max_tokens: 1024,
    messages: [
      {
        role: 'system',
        content: 'You are a helpful assistant that extracts structured information from coding sessions. Always respond with valid JSON only, no explanation.'
      },
      {
        role: 'user',
        content: `Analyze this Claude Code session and extract a structured reasoning summary.

SESSION DATA:
${sessionSummary}

Extract the following as JSON:
{
  "task": "Brief description (1 sentence)",
  "goal": "The underlying problem being solved",
  "reasoning_trace": [
    "Be SPECIFIC: include file names, function names, line numbers when relevant",
    "Format: '[Action] [target] to/for [purpose]'",
    "Example: 'Read auth.ts:47 to understand token refresh logic'",
    "Example: 'Fixed null check in validateToken() - was causing silent failures'",
    "NOT: 'Investigated auth' or 'Fixed bug'"
  ],
  "decisions": [{"choice": "What was decided", "reason": "Why this over alternatives"}],
  "constraints": ["Discovered limitations, rate limits, incompatibilities"],
  "status": "complete|partial|question|abandoned",
  "tags": ["relevant", "domain", "tags"]
}

IMPORTANT for reasoning_trace:
- Each entry should be ACTIONABLE information for future developers
- Include specific file:line references when possible
- Explain WHY not just WHAT (e.g., "Chose JWT over sessions because stateless scales better")
- Bad: "Fixed the bug" / Good: "Fixed race condition in UserService.save() - was missing await"

Status definitions:
- "complete": Task was finished, implementation done
- "partial": Work started but not finished
- "question": Claude asked a question and is waiting for user response
- "abandoned": User interrupted or moved to different topic

RESPONSE RULES:
- English only (translate if input is in other language)
- No emojis
- Valid JSON only`
      }
    ]
  });

  // Parse the response
  const content = response.choices[0]?.message?.content;
  if (!content) {
    throw new Error('No response from OpenAI');
  }

  try {
    // SECURITY: Parse to plain object first, then sanitize prototype pollution
    const rawParsed = JSON.parse(content) as Record<string, unknown>;

    // SECURITY: Prevent prototype pollution from LLM-generated JSON
    // An attacker could manipulate LLM to return {"__proto__": {"isAdmin": true}}
    const pollutionKeys = ['__proto__', 'constructor', 'prototype'];
    for (const key of pollutionKeys) {
      if (key in rawParsed) {
        delete rawParsed[key];
      }
    }

    const extracted = rawParsed as Partial<ExtractedReasoning>;

    // SECURITY: Validate types to prevent LLM injection attacks
    const safeTask = typeof extracted.task === 'string' ? extracted.task : '';
    const safeGoal = typeof extracted.goal === 'string' ? extracted.goal : '';
    const safeTrace = Array.isArray(extracted.reasoning_trace)
      ? extracted.reasoning_trace.filter((t): t is string => typeof t === 'string')
      : [];
    const safeDecisions = Array.isArray(extracted.decisions)
      ? extracted.decisions.filter((d): d is { choice: string; reason: string } =>
          d && typeof d === 'object' && typeof d.choice === 'string' && typeof d.reason === 'string')
      : [];
    const safeConstraints = Array.isArray(extracted.constraints)
      ? extracted.constraints.filter((c): c is string => typeof c === 'string')
      : [];
    const safeTags = Array.isArray(extracted.tags)
      ? extracted.tags.filter((t): t is string => typeof t === 'string')
      : [];

    // Fill defaults with validated values
    return {
      task: safeTask || session.userMessages[0]?.substring(0, 100) || 'Unknown task',
      goal: safeGoal || safeTask || 'Unknown goal',
      reasoning_trace: safeTrace,
      files_touched: session.filesRead.concat(session.filesWritten),
      decisions: safeDecisions,
      constraints: safeConstraints,
      status: validateStatus(extracted.status),
      tags: safeTags
    };
  } catch (parseError) {
    // If JSON parsing fails, return basic extraction
    debugLLM('Failed to parse LLM response, using fallback');
    return createFallbackExtraction(session);
  }
}

/**
 * Classify just the task status (lighter weight than full extraction)
 */
export async function classifyTaskStatus(session: ParsedSession): Promise<TaskStatus> {
  const openai = getClient();

  // Get last few exchanges for classification
  const lastMessages = session.userMessages.slice(-2).join('\n---\n');
  const lastAssistant = session.assistantMessages.slice(-1)[0] || '';

  const response = await openai.chat.completions.create({
    model: 'gpt-3.5-turbo',
    max_tokens: 50,
    messages: [
      {
        role: 'system',
        content: 'Classify conversation state. Return ONLY one word: complete, partial, question, or abandoned.'
      },
      {
        role: 'user',
        content: `Last user message(s):
${lastMessages}

Last assistant response (truncated):
${lastAssistant.substring(0, 500)}

Files written: ${session.filesWritten.length}
Files read: ${session.filesRead.length}

Classification:`
      }
    ]
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    return 'partial';
  }

  return validateStatus(content.trim().toLowerCase());
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

// ============================================
// SESSION SUMMARY FOR CLEAR OPERATION
// Reference: plan_proxy_local.md Section 2.3, 4.5
// ============================================

/**
 * Check if session summary generation is available
 */
export function isSummaryAvailable(): boolean {
  return !!(process.env.ANTHROPIC_API_KEY || process.env.GROV_API_KEY);
}

/**
 * Generate session summary for CLEAR operation
 * Reference: plan_proxy_local.md Section 2.3, 4.5
 */
export async function generateSessionSummary(
  sessionState: SessionState,
  steps: StepRecord[],
  maxTokens: number = 800  // Default 800, CLEAR mode uses 15000
): Promise<string> {
  const client = getAnthropicClient();

  // For larger summaries, include more steps
  const stepLimit = maxTokens > 5000 ? 50 : 20;
  const wordLimit = Math.min(Math.floor(maxTokens / 2), 10000);  // ~2 tokens per word

  const stepsText = steps
    .filter(s => s.is_validated)
    .slice(-stepLimit)
    .map(step => {
      let desc = `- ${step.action_type}`;
      if (step.files.length > 0) {
        desc += `: ${step.files.join(', ')}`;
      }
      if (step.command) {
        desc += ` (${step.command.substring(0, 100)})`;
      }
      if (step.reasoning && maxTokens > 5000) {
        desc += `\n  Reasoning: ${step.reasoning.substring(0, 200)}`;
      }
      return desc;
    })
    .join('\n');

  const prompt = `Create a ${maxTokens > 5000 ? 'comprehensive' : 'concise'} summary of this coding session for context continuation.

ORIGINAL GOAL: ${sessionState.original_goal || 'Not specified'}

EXPECTED SCOPE: ${sessionState.expected_scope.join(', ') || 'Not specified'}

CONSTRAINTS: ${sessionState.constraints.join(', ') || 'None'}

ACTIONS TAKEN:
${stepsText || 'No actions recorded'}

Create a summary with these sections (keep total under ${wordLimit} words):
1. ORIGINAL GOAL: (1-2 sentences)
2. PROGRESS: (${maxTokens > 5000 ? '5-10' : '2-3'} bullet points of what was accomplished)
3. KEY DECISIONS: (important architectural/design choices made, with reasoning)
4. FILES MODIFIED: (list of files with brief description of changes)
5. CURRENT STATE: (detailed status of where the work left off)
6. NEXT STEPS: (recommended next actions to continue)
${maxTokens > 5000 ? '7. IMPORTANT CONTEXT: (any critical information that must not be lost)' : ''}

Format as plain text, not JSON.`;

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }],
  });

  const content = response.content?.[0];
  if (!content || content.type !== 'text') {
    return createFallbackSummary(sessionState, steps);
  }

  return `PREVIOUS SESSION CONTEXT (auto-generated after context limit):

${content.text}`;
}

/**
 * Create fallback summary without LLM
 */
function createFallbackSummary(sessionState: SessionState, steps: StepRecord[]): string {
  const files = [...new Set(steps.flatMap(s => s.files))];

  return `PREVIOUS SESSION CONTEXT (auto-generated after context limit):

ORIGINAL GOAL: ${sessionState.original_goal || 'Not specified'}

PROGRESS: ${steps.length} actions taken

FILES MODIFIED:
${files.slice(0, 10).map(f => `- ${f}`).join('\n') || '- None recorded'}

Please continue from where you left off.`;
}

// ============================================
// TASK ORCHESTRATION (Task identification)
// Reference: plan_proxy_local.md Part 8
// ============================================

/**
 * Task analysis result from Haiku
 */
export interface TaskAnalysis {
  task_type: 'information' | 'planning' | 'implementation';
  action: 'continue' | 'new_task' | 'subtask' | 'parallel_task' | 'task_complete' | 'subtask_complete';
  task_id: string;
  current_goal: string;
  parent_task_id?: string;
  reasoning: string;
  step_reasoning?: string;  // Compressed reasoning for steps (if assistantResponse > 1000 chars)
}

/**
 * Conversation message for task analysis
 */
export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Check if task analysis is available
 */
export function isTaskAnalysisAvailable(): boolean {
  return !!(process.env.ANTHROPIC_API_KEY || process.env.GROV_API_KEY);
}

/**
 * Format conversation messages for prompt
 */
function formatConversationHistory(messages: ConversationMessage[]): string {
  if (!messages || messages.length === 0) return 'No conversation history available.';

  return messages.slice(-10).map(m => {
    const role = m.role === 'user' ? 'User' : 'Assistant';
    const content = m.content.substring(0, 800);
    const truncated = m.content.length > 800 ? '...' : '';
    return `${role}: ${content}${truncated}`;
  }).join('\n\n');
}

/**
 * Format tool calls for prompt
 */
function formatToolCalls(steps: StepRecord[]): string {
  if (!steps || steps.length === 0) return 'No tools used yet.';

  return steps.slice(0, 10).map(s => {
    let desc = `- ${s.action_type}`;
    if (s.files.length > 0) {
      desc += `: ${s.files.slice(0, 3).join(', ')}`;
    }
    if (s.command) {
      desc += ` (${s.command.substring(0, 50)})`;
    }
    return desc;
  }).join('\n');
}

/**
 * Analyze task context to determine task status
 * Called after each main model response to orchestrate sessions
 * Also compresses reasoning for steps if assistantResponse > 1000 chars
 */
export async function analyzeTaskContext(
  currentSession: SessionState | null,
  latestUserMessage: string,
  recentSteps: StepRecord[],
  assistantResponse: string,
  conversationHistory?: ConversationMessage[]
): Promise<TaskAnalysis> {
  const client = getAnthropicClient();

  // Check if we need to compress reasoning
  const needsCompression = assistantResponse.length > 1000;
  const compressionInstruction = needsCompression
    ? `,
  "step_reasoning": "Extract CONCLUSIONS only: specific file paths, function names, patterns discovered, and WHY decisions were made. Max 800 chars. Do not write process descriptions."`
    : '';

  // Format conversation history
  const historyText = formatConversationHistory(conversationHistory || []);
  const toolCallsText = formatToolCalls(recentSteps);

  const prompt = `You are a task status analyzer. Your job is to examine a conversation between a user and an AI assistant, then determine whether the current task is complete, still in progress, or if a new task has started.

<input>
original_goal: ${currentSession?.original_goal || 'No active task - this may be the first message'}

messages:
${historyText}

current_assistant_response:
${assistantResponse ? assistantResponse.substring(0, 2000) : 'No response yet - assistant is still thinking.'}

tool_calls:
${toolCallsText}
</input>

<output>
Return a JSON object with these fields:
- task_type: one of "information", "planning", or "implementation"
- action: one of "continue", "task_complete", "new_task", or "subtask_complete"
- task_id: existing session_id "${currentSession?.session_id || 'NEW'}" or "NEW" for new task
- current_goal: the goal based on the latest user message
- reasoning: brief explanation of why you made this decision${compressionInstruction}
</output>

<step_1_identify_task_type>
First, analyze the original_goal to understand what kind of task this is. Do not rely on specific keywords. Instead, understand the user's intent from the full context of their message.

TYPE A - Information Request
The user wants to learn or understand something. They are seeking knowledge, not asking for any changes or decisions to be made. The answer itself is what they need.

Think about whether the user is curious about how something works, wants an explanation of a concept, or is asking for clarification about existing behavior.

Examples of information requests in different phrasings:
- "How does the authentication system work?"
- "Explica-mi cum functioneaza cache-ul"
- "What is the difference between Redis and Memcached?"
- "Can you walk me through the payment flow?"
- "I don't understand why this function returns null"
- "Ce face acest cod?"

TYPE B - Planning or Decision Request
The user wants to figure out the best approach before taking action. They need to make a decision or create a plan. The conversation may involve exploring options, discussing tradeoffs, or clarifying requirements.

Think about whether the user is trying to decide between approaches, wants recommendations for how to build something, or is working toward a plan they will implement later.

Examples of planning requests in different phrasings:
- "How should we implement user authentication?"
- "What's the best way to handle caching for this API?"
- "Cum ar trebui sa structuram baza de date?"
- "I'm thinking about using Redis vs Memcached, what do you recommend?"
- "Let's figure out the architecture before we start coding"
- "We need to decide on the approach for handling errors"

TYPE C - Implementation Request
The user wants actual changes made. They want code written, files edited, commands run, or something built. The task involves using tools to modify the codebase.

Think about whether the user is asking for something to be created, fixed, changed, or built.

Examples of implementation requests in different phrasings:
- "Fix the bug in the login function"
- "Add caching to the API endpoints"
- "Fa un refactor la modulul de plati"
- "Create a new component for the dashboard"
- "Update the tests to cover edge cases"
- "Remove the deprecated authentication code"
</step_1_identify_task_type>

<step_2_determine_status>
Now that you know the task type, determine whether it is complete, continuing, or if a new task has begun.

For TYPE A - Information Request:
The task is complete when the assistant has provided a clear and complete answer to the user's question. Check the current_assistant_response field - if it contains a substantive answer to the question, the task is complete.

Each question the user asks is treated as its own separate task. If the user asks a follow-up question, even on the same topic, that is a new task.

The reason for this is that each answer is valuable on its own and should be saved independently. We do not want to wait for a multi-turn conversation to end before saving useful information.

When analyzing: Look at current_assistant_response. If it contains an explanation, answer, or clarification that addresses the user's question, return task_complete.

Example situation: User asks "How does auth work?", assistant explains it fully.
Decision: task_complete
Reason: The information request was answered completely.

Example situation: User asks "How does auth work?", assistant explains, then user asks "What about JWT specifically?"
Decision for second message: new_task
Reason: This is a new question requiring a new answer.

For TYPE B - Planning or Decision Request:
The task continues while the user and assistant are still exploring options, discussing tradeoffs, or clarifying requirements. The task is complete only when a final decision or plan has been reached and the user has confirmed it.

Look for signals that indicate the user has made up their mind. These signals come from the overall tone and direction of the conversation, not from specific keywords. The user might express agreement, ask to proceed with implementation, or summarize the chosen approach.

When analyzing, ask yourself: Has the user confirmed a final direction? Are they still weighing options? Have they asked to move forward with a specific approach?

Example situation: User asks "Should we use JWT or sessions?", assistant explains both, user says "I'm still not sure about refresh tokens"
Decision: continue
Reason: The user is still clarifying and has not made a final decision.

Example situation: User and assistant discussed auth options, user says "OK, JWT with refresh tokens makes sense, let's go with that"
Decision: task_complete
Reason: The user confirmed the decision. Planning is complete.

Example situation: User says "That sounds good, now implement it"
Decision: task_complete for planning, and a new implementation task will begin
Reason: Planning concluded with a decision. User is now requesting implementation.

For TYPE C - Implementation Request:
The task continues while the assistant is actively making changes using tools like file edits, bash commands, or file writes. The task is complete when the changes are done and verified.

Look for signals that the work is finished in current_assistant_response: successful test runs, the assistant stating the work is done, or a commit being made. If tests are failing or the assistant indicates more work is needed, the task continues.

When analyzing: Check current_assistant_response for completion signals. Is the assistant still making changes? Have the changes been verified? Did the assistant confirm completion?

Example situation: Assistant edited three files and is now running tests.
Decision: continue
Reason: Implementation is in progress, verification not yet complete.

Example situation: Assistant ran tests, they passed, assistant says "Done, the auth bug is fixed"
Decision: task_complete
Reason: Changes are complete and verified.

Example situation: Tests failed after the changes.
Decision: continue
Reason: The implementation needs more work to pass verification.
</step_2_determine_status>

<step_3_detect_new_task>
Sometimes the user changes direction entirely. A new task has started when:

The user asks about something completely unrelated to the original goal.
The conversation topic shifts to a different part of the codebase or a different feature.
The previous task was completed and the user is now requesting something new.

To detect this, compare the current user message to the original_goal. If they are about the same thing, the task is either continuing or complete. If they are about different things, a new task has started.

Be careful not to confuse follow-up questions with new tasks. A follow-up question on the same topic in an information request is a new task because each answer stands alone. But a follow-up clarification during planning is part of the same planning task.

Example situation: Original goal was "fix the auth bug", user now asks "also, can you update the README?"
Decision: new_task
Reason: Updating README is unrelated to fixing the auth bug.

Example situation: Original goal was "implement caching", user asks "should we use Redis or Memcached for this?"
Decision: continue (this is planning within the implementation task)
Reason: The question is about how to implement the original request.

Example situation: Original goal was "explain how auth works", user asks "and how does the session storage work?"
Decision: new_task
Reason: This is a new information request, separate from the first.
</step_3_detect_new_task>

<important_notes>
Do not rely on specific keywords in any language. The same intent can be expressed many different ways across languages and phrasings. Always understand the intent from the full context.

The conversation history and tool usage are your most important signals. What has the assistant been doing? What is the user trying to accomplish? Has that goal been achieved?

When in doubt between continue and task_complete, ask yourself: Would it be valuable to save what we have so far? For information requests, yes, save each answer. For planning, only save when a decision is made. For implementation, only save when work is verified complete.

RESPONSE RULES:
- Return valid JSON only
- English only in the response (translate reasoning if input is in other language)
- No markdown formatting, no emojis
</important_notes>`;

  debugLLM('analyzeTaskContext', `Calling Haiku for task analysis (needsCompression=${needsCompression})`);

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: needsCompression ? 800 : 400,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content[0].type === 'text' ? response.content[0].text : '';

  try {
    // Try to parse JSON from response (may have extra text)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('No JSON found in response');
    }
    const analysis = JSON.parse(jsonMatch[0]) as TaskAnalysis;

    // Ensure task_type has a default value
    if (!analysis.task_type) {
      analysis.task_type = 'implementation';
    }

    // If we didn't need compression but have short response, use it directly
    if (!needsCompression && assistantResponse.length > 0) {
      analysis.step_reasoning = assistantResponse.substring(0, 1000);
    }

    debugLLM('analyzeTaskContext', `Result: task_type=${analysis.task_type}, action=${analysis.action}, goal=${analysis.current_goal?.substring(0, 50) || 'N/A'}`);

    return analysis;
  } catch (parseError) {
    debugLLM('analyzeTaskContext', `Parse error: ${String(parseError)}, using fallback`);

    // Fallback: continue existing session or create new
    return {
      task_type: 'implementation',
      action: currentSession ? 'continue' : 'new_task',
      task_id: currentSession?.session_id || 'NEW',
      current_goal: latestUserMessage.substring(0, 200),
      reasoning: 'Fallback due to parse error',
      step_reasoning: assistantResponse.substring(0, 1000),
    };
  }
}

// ============================================
// REASONING & DECISIONS EXTRACTION (at task_complete)
// Reference: conversation fixes - extract from steps
// ============================================

export interface ExtractedReasoningAndDecisions {
  reasoning_trace: string[];
  decisions: Array<{ choice: string; reason: string }>;
}

/**
 * Check if reasoning extraction is available
 */
export function isReasoningExtractionAvailable(): boolean {
  return !!process.env.ANTHROPIC_API_KEY || !!process.env.GROV_API_KEY;
}

/**
 * Extract reasoning trace and decisions from steps
 * Called at task_complete to populate team memory with rich context
 *
 * @param formattedSteps - Pre-formatted XML string with grouped steps and actions
 * @param originalGoal - The original task goal
 */
export async function extractReasoningAndDecisions(
  formattedSteps: string,
  originalGoal: string
): Promise<ExtractedReasoningAndDecisions> {
  const client = getAnthropicClient();

  if (formattedSteps.length < 50) {
    return { reasoning_trace: [], decisions: [] };
  }

  const prompt = `<role>
You are a Knowledge Engineer specialized in extracting reusable team knowledge from coding sessions.

Your output will be stored permanently in team memory and used to help developers in future sessions. Poor extractions waste storage and confuse future assistants. Excellent extractions save hours of repeated investigation.
</role>

<context>
PROJECT GOAL: ${originalGoal || 'Not specified'}

This extraction serves two purposes:
1. Help future developers understand WHAT was discovered in this codebase
2. Help future developers understand WHY certain decisions were made
</context>

<session_data>
${formattedSteps.substring(0, 8000)}
</session_data>

<instructions>

We need TWO types of knowledge extracted:

TYPE A: CONCLUSIONS (Factual findings from the session)

What this means:
These are FACTS discovered during the session. Things that were explicitly found, read, or confirmed in the code. A new developer reading these should immediately know WHERE to find things and WHAT values/patterns exist.

Must include:
- Specific file paths (not just "auth files" but "src/lib/jwt.ts")
- Specific values (not just "short expiry" but "1 hour access, 7 day refresh")
- Specific patterns (not just "uses JWT" but "JWT with sub, email, type, teams payload")
- Specific functions/classes (not just "middleware" but "requireAuth, optionalAuth preHandlers")

Format: Start with "CONCLUSION: " prefix

Good examples:
- "CONCLUSION: JWT tokens stored in ~/.grov/credentials.json with 1hr access/7d refresh expiry"
- "CONCLUSION: Auth middleware in src/routes/auth.ts exports requireAuth and optionalAuth preHandlers"
- "CONCLUSION: Device flow polling interval is 5 seconds, endpoint /auth/device/poll"

Bad examples:
- "CONCLUSION: Found authentication files" (too vague, no paths)
- "CONCLUSION: JWT is used for auth" (too generic, no specifics)
- "CONCLUSION: Explored the codebase" (process description, not finding)


TYPE B: INSIGHTS (Your analysis and inferences)

What this means:
These are YOUR observations that go BEYOND what was explicitly stated. Connections between different parts, patterns you identified, implications for future work. This is where YOU add value beyond just summarizing.

Types of insights we value:

1. CONNECTIONS - How do different files/modules relate?
Example: "jwt.ts handles token creation, credentials.ts handles storage - separation of crypto operations from I/O"

2. INFERENCES - What decisions were made implicitly?
Example: "File storage in ~/.grov/ instead of env vars - implies single-user CLI design, not multi-tenant"

3. PATTERNS - What architectural patterns emerge?
Example: "All config files use 0600 permissions - security-conscious design for sensitive data"

4. IMPLICATIONS - What does this mean for future development?
Example: "1hr token expiry requires background refresh mechanism for long operations to avoid mid-task auth failures"

Format: Start with "INSIGHT: " prefix

Good examples:
- "INSIGHT: Dual-file pattern (jwt.ts + credentials.ts) separates crypto from I/O, reducing attack surface"
- "INSIGHT: Device Authorization Flow chosen over password flow - enables OAuth providers without storing secrets in CLI"
- "INSIGHT: Teams array cached in JWT payload - avoids DB query per request but requires token refresh on team changes"

Bad examples:
- "INSIGHT: The code is well organized" (subjective, not actionable)
- "INSIGHT: Authentication is important" (obvious, no value)
- "INSIGHT: Files were read" (process description, not insight)

</instructions>

<output_format>
Return a JSON object with this structure:

{
  "reasoning_trace": [
    "CONCLUSION: [specific factual finding with file paths and values]",
    "CONCLUSION: [another specific finding]",
    "INSIGHT: [connection or inference you identified]",
    "INSIGHT: [implication for future work]"
  ],
  "decisions": [
    {
      "choice": "[What was chosen - be specific]",
      "reason": "[Why - include whether this is factual or inferred]"
    }
  ]
}

Rules:
1. ALWAYS include CONCLUSIONS first (the factual findings)
2. ADD INSIGHTS where you can infer something not explicitly stated
3. Use the prefixes "CONCLUSION: " and "INSIGHT: " for clarity
4. Max 10 reasoning_trace entries - prioritize most valuable
5. Max 5 decisions - only significant architectural choices
6. If you cannot find specific file paths or values, re-read the input
7. If you cannot add insights beyond conclusions, that's OK - conclusions alone are valuable
8. NEVER include process descriptions ("explored", "searched", "looked at")
9. English only, no emojis
</output_format>

<validation>
Before responding, verify:
- Does each CONCLUSION contain a specific file path or value?
- Does each INSIGHT add something NOT explicitly in the input?
- Would a new developer find this useful without seeing the original session?
- Did I avoid process descriptions?
- Are the decisions about significant architectural choices?
</validation>

Return ONLY valid JSON, no markdown code blocks, no explanation.`;

  debugLLM('extractReasoningAndDecisions', `Analyzing formatted steps, ${formattedSteps.length} chars`);

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 800,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0].type === 'text' ? response.content[0].text : '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);

    if (!jsonMatch) {
      debugLLM('extractReasoningAndDecisions', 'No JSON found in response');
      return { reasoning_trace: [], decisions: [] };
    }

    const result = JSON.parse(jsonMatch[0]) as ExtractedReasoningAndDecisions;
    debugLLM('extractReasoningAndDecisions', `Extracted ${result.reasoning_trace?.length || 0} traces, ${result.decisions?.length || 0} decisions`);

    return {
      reasoning_trace: result.reasoning_trace || [],
      decisions: result.decisions || [],
    };
  } catch (error) {
    debugLLM('extractReasoningAndDecisions', `Error: ${String(error)}`);
    return { reasoning_trace: [], decisions: [] };
  }
}
