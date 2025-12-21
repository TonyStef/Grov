// LLM-based extraction using Anthropic Claude Haiku for drift detection

import Anthropic from '@anthropic-ai/sdk';
import { config } from 'dotenv';
import { join } from 'path';
import { homedir } from 'os';
import { existsSync } from 'fs';
import type { SessionState, StepRecord } from './store.js';
import type { ReasoningTraceEntry } from '@grov/shared';
import { debugLLM } from './debug.js';
import { truncate } from './utils.js';

// Load ~/.grov/.env as fallback for API key
// This allows users to store their API key in a safe location outside any repo
const grovEnvPath = join(homedir(), '.grov', '.env');
if (existsSync(grovEnvPath)) {
  config({ path: grovEnvPath });
}

let anthropicClient: Anthropic | null = null;

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
  "goal": "A single, high-density sentence describing the technical intent. RULES: 1. No bullet points, no newlines. 2. Must include the main Technology Name (e.g. 'Prometheus', 'React', 'AWS') if inferred. 3. If the user provided a list, synthesize it into one summary statement. Example: 'Implement Prometheus metrics collection with counter and gauge primitives' instead of 'Add metrics: - counters - gauges'.",
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
        goal: typeof parsed.goal === 'string' ? parsed.goal : '',  // Don't fallback to prompt
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
    goal: '',  // Empty - don't copy user prompt as goal; goal should be synthesized only
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
- current_goal: "SYNTHESIZE a concise goal (max 150 chars). RULES: 1. If original_goal is empty, SYNTHESIZE from user messages. 2. DO NOT copy the user's request verbatim - summarize it. 3. Start with Technology/Component name. 4. One sentence, no newlines. Example: 'TypeScript Logger with level filtering and JSON output' NOT 'Create a structured logger in /home/... with debug, info...'"
- reasoning: brief explanation of why you made this decision${compressionInstruction}
</output>

<step_1_identify_task_type>
First, analyze the original_goal to understand what kind of task this is. Do not rely on specific keywords. Instead, understand the user's intent from the full context of their message.

TYPE A - Information Request
The user wants to learn or understand something. They are seeking knowledge, not asking for any changes or decisions to be made. The answer itself is what they need.

This INCLUDES clarifying questions about what the assistant already explained:
- Asking for confirmation: "Are you sure about X?"
- Asking for clarification: "Did you mean Y?"
- Checking understanding: "Does this also apply to Z?"

These questions REFERENCE the previous response and seek clarification, not new decisions.

Think about whether the user is curious about how something works, wants an explanation of a concept, or is asking about something the assistant already said.

Examples of information requests:
- "How does the authentication system work?"
- "Explica-mi cum functioneaza cache-ul"
- "What is the difference between Redis and Memcached?"
- "Can you walk me through the payment flow?"
- "I don't understand why this function returns null"
- "Ce face acest cod?"
- "Are you sure this method works for async calls?" (asking about previous explanation)
- "When you said RAM storage, did you mean on the user's machine?" (clarifying what was said)
- "Does this approach also handle edge cases?" (checking understanding)

TYPE B - Planning or Decision Request
The user is asking the assistant to HELP THEM CHOOSE between options. The decision does NOT exist yet - they are deciding now. The user introduces alternatives and wants a recommendation or to weigh tradeoffs together.

Think about whether the user is introducing new options to choose between, wants recommendations for how to build something, or is working toward a plan they will implement later.

KEY DISTINCTION from Information:
- Planning: User introduces options to choose between → "Should we use X or Y?"
- Information: User asks about what assistant already said → "You mentioned X, are you sure?"

If the assistant ALREADY explained or decided something, and the user is asking about THAT explanation, it is Information, not Planning.

Examples of planning requests:
- "How should we implement user authentication?" (no decision made yet)
- "What's the best way to handle caching for this API?" (asking for recommendation)
- "Cum ar trebui sa structuram baza de date?" (exploring options)
- "I'm thinking about using Redis vs Memcached, what do you recommend?" (user introduces options)
- "Let's figure out the architecture before we start coding" (planning session)
- "We need to decide on the approach for handling errors" (decision needed)

NOT planning (these are Information):
- "Are you sure Redis is the right choice?" (asking about previous recommendation)
- "Did you mean async or sync?" (clarifying what was said)
- "Will this also work for the edge cases we discussed?" (checking understanding)

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

CRITICAL - NEW TASK COMPLETED IN SAME TURN:
If the user's message starts a NEW task (different topic from original_goal) AND the assistant's response COMPLETES that new task in the same turn, use task_complete (NOT new_task).

Example: Original goal was "implement cache service", user now asks "build an EventEmitter class", assistant writes the complete EventEmitter code.
Decision: task_complete
Reason: The new task was requested AND completed. Use task_complete so it gets saved with the new goal.

The key insight: task_complete saves the memory. If you return new_task, the work won't be saved until a FUTURE completion. If Claude already finished the work, use task_complete.
</step_3_detect_new_task>

<important_notes>
Do not rely on specific keywords in any language. The same intent can be expressed many different ways across languages and phrasings. Always understand the intent from the full context.

The conversation history and tool usage are your most important signals. What has the assistant been doing? What is the user trying to accomplish? Has that goal been achieved?

CRITICAL - Q&A DURING PLANNING:
If the current task_type is "planning" and the user asks a clarifying question (e.g., "how does X work?", "what about Y?", "clarify Z"), this is NOT a new information task. It is a CONTINUATION of the planning task. The user is gathering information to make a planning decision, not requesting standalone information.
- If original task_type was planning → keep it as planning, action=continue
- Only mark task_complete for planning when user explicitly confirms a final decision or asks to proceed with implementation
- Asking to "write to file" or "document the plan" is NOT task_complete - it's still part of planning documentation

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

    debugLLM('analyzeTaskContext', `Result: task_type=${analysis.task_type}, action=${analysis.action}, goal="${analysis.current_goal?.substring(0, 50) || 'N/A'}" reasoning="${analysis.reasoning?.substring(0, 150) || 'none'}"`);

    return analysis;
  } catch (parseError) {
    debugLLM('analyzeTaskContext', `Parse error: ${String(parseError)}, using fallback`);

    // Fallback: continue existing session or create new
    // Use existing goal if available, otherwise leave empty (don't copy user prompt)
    const fallbackGoal = currentSession?.original_goal && currentSession.original_goal.length > 0
      ? currentSession.original_goal
      : '';  // Don't synthesize from user message - leave empty

    return {
      task_type: 'implementation',
      action: currentSession ? 'continue' : 'new_task',
      task_id: currentSession?.session_id || 'NEW',
      current_goal: fallbackGoal,
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
  system_name: string | null;     // Parent system anchor (e.g., 'Retry Queue') - prefixes all chunks
  summary: string | null;         // Content summary for semantic search (150-200 chars)
  reasoning_trace: ReasoningTraceEntry[];  // Union type for backwards compatibility
  decisions: Array<{ aspect?: string; tags?: string; choice: string; reason: string }>;
}

// Internal interface for Haiku response with knowledge pairs
interface HaikuKnowledgePair {
  aspect: string;         // Specific component within system (e.g., 'Job State Model')
  tags?: string;          // DEPRECATED: kept for backwards compat
  conclusion: string;
  insight: string | null;
}

interface HaikuExtractionResponse {
  system_name?: string;            // Parent system anchor (e.g., 'Retry Queue')
  summary?: string;                // Content summary for semantic search
  knowledge_pairs?: HaikuKnowledgePair[];
  reasoning_trace?: string[];      // Backwards compatibility with old format
  decisions?: Array<{ aspect?: string; tags?: string; choice: string; reason: string }>;
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
    return { system_name: null, summary: null, reasoning_trace: [], decisions: [] };
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

*** GLOBAL STANDARDS FOR CODE REFERENCES ***

We want "Code Anchors" (Searchable Names), NOT "Implementation Logic" (Syntax).

1. NO SYNTAX / NO LOGIC:
   - STRICTLY FORBIDDEN: \`if\`, \`for\`, \`while\`, \`=>\`, \`return\`, \`{ }\`, \`;\`.
   - NEVER write snippet-style logic.
   - BAD: "Uses \`user.id ? save() : null\` to persist." (This is logic)
   - GOOD: "Uses \`save()\` method on \`User\` entity." (This is a named reference)

2. USE "NAMED ENTITIES" ONLY:
   - Treat code references as Proper Nouns (Substantive Proprii).
   - Only reference Names of: Functions, Classes, File Paths, Constants, Env Vars, Config Keys.
   - Format: Wrap them in single backticks (e.g., \`auth.ts\`, \`MAX_RETRIES\`).

3. BE CONCISE:
   - Do not paste long paths if not necessary. Use relative paths.
   - BAD: \`src/features/users/controllers/auth.controller.ts\` (Too noisy)
   - GOOD: \`auth.controller.ts\` (Sufficient anchor)

4. FACTUAL EXTRACTION (CRITICAL FOR Q&A SESSIONS):

PURPOSE: All extracted knowledge must be FACTUAL STATEMENTS about the codebase,
NOT descriptions of the conversation or session.

WHY THIS MATTERS:
- Chunks are stored as embeddings for semantic search
- "User asked about caching" has DIFFERENT embedding than "Cache uses LRU eviction"
- If we store meta-descriptions, future searches will NOT match
- We need UNIFORM factual statements regardless of session type (Q&A or implementation)

FORBIDDEN PATTERNS (NEVER USE THESE):

BANNED PHRASES - do NOT start sentences with:
- "User asked...", "Explained that...", "Discussed..."
- "The conversation...", "This session...", "It was determined..."
- "We talked about...", "Question about...", "Answered...", "Covered...", "Explored..."

BANNED META-WORDS anywhere in text:
- "session", "conversation", "discussion", "chat"
- "user", "developer", "team" (when used as actors doing things)
- "asked", "explained", "answered", "clarified"
- "this memory", "this task", "this query"

TRANSFORMATION EXAMPLES:

Example 1 - Authentication Q&A:
  Session context: User asked "How does auth work?" then explained JWT flow
  BAD: "User asked about authentication. Explained it uses JWT tokens."
  BAD: "Discussion covered the auth mechanism and its JWT implementation."
  GOOD: "Authentication uses JWT tokens with 24h expiry for stateless verification."

Example 2 - Caching explanation:
  Session context: User asked "Why use Map for LRU?" then explained insertion order
  BAD: "Explained why JavaScript Map was chosen for the LRU cache."
  BAD: "Answered question about Map's insertion order property."
  GOOD: "LRU Cache uses JavaScript Map because Map guarantees insertion order."

Example 3 - Architecture discussion:
  Session context: User asked "What pattern does Circuit Breaker use?"
  BAD: "Discussed the Circuit Breaker pattern and its three states."
  GOOD: "Circuit Breaker implements finite state machine with CLOSED, OPEN, HALF_OPEN states."

MENTAL MODEL FOR EXTRACTION:

Ask yourself: "If I remove all context about WHO asked and WHEN, what FACTUAL
KNOWLEDGE about the CODE remains?"

Transform pattern:
1. Identify the SUBJECT (component, function, pattern)
2. Identify the BEHAVIOR (what it does, how it works)
3. Identify the IMPLEMENTATION (specific details, values, files)
4. Write: "[SUBJECT] [BEHAVIOR] [IMPLEMENTATION]"

Result pattern: "[Component] uses/implements/provides [mechanism] for/via/with [details]"

Examples of correct factual statements:
- "Retry Queue uses exponential backoff with 1s base delay"
- "EventEmitter implements copy-before-iterate for safe listener removal"
- "LRU Cache provides O(1) eviction via Map insertion order property"

SELF-CHECK BEFORE OUTPUT:

Before returning, verify EACH knowledge_pair and decision:
- Does it start with a code component/system, NOT "User/Explained/Discussed"?
- Is it a factual statement about code, NOT about the conversation?
- Could this exact sentence appear in technical documentation?
- If someone searches for this topic, would this sentence match?

If ANY answer is NO, rewrite it as a factual statement.

TYPE A: CONCLUSIONS (Factual Findings)

What this means:
Facts explicitly found in the code.
CRITICAL GOAL: Eliminate vagueness. Replace generic descriptions with specific "Named Entities" defined above.

Rules for High-Quality Conclusions:

1. The "Who" Rule:
   - NEVER start with "The system", "The function", or "We found".
   - Start with the specific Component/Class/File Name.
   - BAD: "The function calculates the hash."
   - GOOD: "\`FileScanner\` calculates \`SHA-256\` hash."

2. The "Value" Rule:
   - Do not use adjectives like "short", "large", "standard". Use the actual values found.
   - BAD: "Sets a short timeout."
   - GOOD: "Sets \`connectionTimeout\` to \`500ms\`."

3. The "Location" Rule:
   - Always mention WHERE this happens (File or Module).
   - BAD: "Validates the token."
   - GOOD: "Validates \`jwt_token\` inside \`auth.middleware.ts\`."

Format Pattern:
"CONCLUSION: [Code Anchor Subject] performs [Action] using [Code Anchor Object/Value]"

Examples:
- "CONCLUSION: \`JwtService\` in \`jwt.ts\` signs tokens with \`RS256\` algorithm, \`1hr\` expiry"
- "CONCLUSION: \`requireAuth\` preHandler in \`auth.ts\` validates \`Authorization\` header"
- "CONCLUSION: \`CredentialStore\` writes to \`~/.grov/credentials.json\` with \`0600\` permissions"

═══════════════════════════════════════════════════════════════

TYPE B: INSIGHTS (Architectural Analysis)

What this means:
The architectural "Why" behind the code.
CRITICAL GOAL: Connect the code to a Computer Science Concept or Business Outcome.

Rules for High-Quality Insights:

1. Name the Pattern/Trade-off:
   - Use standard terminology: "Singleton", "Lazy Loading", "Race Condition", "O(N) Complexity", "Dependency Injection", "Circuit Breaker".
   - BAD: "This is good for organizing code."
   - GOOD: "Implements \`Dependency Injection\` to decouple storage logic."

2. Explain the "Hard" Consequence:
   - Focus on: Memory, CPU, Latency, Security, Consistency, Disk I/O.
   - BAD: "It makes it faster."
   - GOOD: "Reduces I/O operations by caching \`scan_result\` in memory."

Format Pattern:
"INSIGHT: Implements [Pattern Name] to optimize [Resource/Outcome] by [Specific Mechanism]"

Examples:
- "INSIGHT: \`timingSafeEqual\` prevents timing attacks - constant-time comparison regardless of input"
- "INSIGHT: Lazy expiration pattern in \`MemoryCache\` - trades read latency for no timer overhead"
- "INSIGHT: JWT payload caches \`teams[]\` - avoids DB query per request, requires refresh on team change"

</instructions>

<summary_rules>
═══════════════════════════════════════════════════════════════
SUMMARY GENERATION - CRITICAL FOR SEMANTIC SEARCH
═══════════════════════════════════════════════════════════════

FRONT-LOADING RULE:
First 7-8 words determine 80% of search match quality.
Start DIRECTLY with the main technology or system name, then immediately follow with what was done in a few key words.

WRONG: "In this session we implemented a metrics system..."
WRONG: "This memory contains information about..."
WRONG: "Discussion about implementing..."
RIGHT: "Prometheus Metrics System with Counter, Gauge, Histogram primitives..."
RIGHT: "Event Bus pub/sub with wildcard subscriptions and circular buffer..."
RIGHT: "Redis caching layer with TTL expiration and LRU eviction..."

CONTENT RULES:
1. Lead with technology/system name (Prometheus, Redis, Event Bus, AWS S3)
2. Include 2-3 key technical terms that users would search for
3. NO meta-language: ban "this memory", "discussion about", "implemented", "session"
4. NO file paths (save those for conclusions)
5. Describe WHAT it is, not WHAT was done

LENGTH: 150-200 characters MAXIMUM. Dense, not verbose.
</summary_rules>

<output_format>
Return a JSON object with this structure:

{
  "system_name": "[MANDATORY - see SYSTEM_NAME RULES below]",
  "summary": "[150-200 chars MAX - MUST follow SUMMARY RULES above]",
  "knowledge_pairs": [
    {
      "aspect": "[Specific component within system - see ASPECT RULES below]",
      "conclusion": "CONCLUSION: [specific factual finding with file paths and values]",
      "insight": "INSIGHT: [inference or implication RELATED to this conclusion]"
    }
  ],
  "decisions": [
    {
      "aspect": "[Specific component this decision is about]",
      "choice": "[What was chosen - be specific. Max 100 chars]",
      "reason": "[Why - include whether this is factual or inferred. Max 150 chars]"
    }
  ]
}

═══════════════════════════════════════════════════════════════
SYSTEM_NAME RULES (MANDATORY - TOP LEVEL FIELD)
═══════════════════════════════════════════════════════════════

PURPOSE: This is the "parent anchor" that connects all knowledge and decisions to the same system. It will be prepended to EVERY chunk for semantic search.

WHAT TO PUT: The main system, component, or feature being discussed in this task. Extract it from the PROJECT GOAL - ask yourself "What is being built/analyzed/debugged?"

HOW TO IDENTIFY:
- Look at the goal/query - what noun represents the main subject?
- It should be a PROPER NOUN (specific name), not a generic term
- If goal is "Build a retry queue with exponential backoff" then system_name is "Retry Queue"
- If goal is "Fix authentication bug in login flow" then system_name is "Auth Module" or "Login Flow"
- If goal is "Optimize database queries for user search" then system_name is "User Search" or "Search Query Optimizer"

GOOD EXAMPLES:
- "Retry Queue" (specific component)
- "Webhook Delivery System" (specific feature)
- "Rate Limiter" (specific utility)
- "JWT Authentication" (specific mechanism)
- "Memory Cache" (specific component)
- "File Scanner" (specific service)

BAD EXAMPLES:
- "System" (too generic)
- "Code" (meaningless)
- "Implementation" (not a noun/component)
- "Backend" (too broad)
- "Feature" (not specific)
- "The function" (not a name)

RULE: If a user searches "How does [system_name] work?", this field should make that search find ALL chunks from this memory.

═══════════════════════════════════════════════════════════════
ASPECT RULES (per knowledge_pair and decision)
═══════════════════════════════════════════════════════════════

PURPOSE: The specific component, pattern, or topic WITHIN the system_name that THIS PARTICULAR entry discusses. More granular than system_name.

WHAT TO PUT: The specific part of the system this knowledge/decision is about. Ask yourself "What specific aspect of [system_name] does this entry cover?"

RELATIONSHIP TO system_name:
- system_name = "Retry Queue" (the whole system)
- aspect = "Job State Model" (one specific part)
- aspect = "Backoff Strategy" (another specific part)
- aspect = "Failed Job Recovery" (another specific part)

HOW TO IDENTIFY:
- What sub-component or pattern does this entry describe?
- What would you title this paragraph if it were a section header?
- It should be MORE SPECIFIC than system_name

GOOD EXAMPLES (for system_name = "Retry Queue"):
- "Job State Model" (how jobs are stored)
- "Backoff Strategy" (how delays work)
- "Failed Job Recovery" (how failures are handled)
- "Queue Statistics" (how stats are exposed)

GOOD EXAMPLES (for system_name = "Webhook Delivery"):
- "Signature Verification" (security aspect)
- "Retry Logic" (reliability aspect)
- "Payload Serialization" (data format aspect)
- "Timeout Handling" (error handling aspect)

BAD EXAMPLES:
- Same as system_name (redundant - don't repeat parent)
- "Implementation" (not specific)
- "Code" (meaningless)
- "Logic" (too vague)

═══════════════════════════════════════════════════════════════

IMPORTANT: Generate knowledge as PAIRS where each INSIGHT is directly related to its CONCLUSION.

Example with system_name and aspect:
{
  "system_name": "Memory Cache",
  "knowledge_pairs": [
    {
      "aspect": "Expiration Strategy",
      "conclusion": "CONCLUSION: Uses lazy expiration - entries checked/deleted on get(), not via timers",
      "insight": "INSIGHT: Lazy expiration avoids timer overhead - trades CPU on read for memory efficiency"
    }
  ]
}

Rules:
1. system_name is MANDATORY - identifies the parent system for ALL entries
2. Each pair MUST have aspect, conclusion AND a related insight
3. aspect should be MORE SPECIFIC than system_name (not the same)
4. The insight MUST add value beyond the conclusion (inference, implication, pattern)
5. DO NOT repeat system_name in conclusion/insight
6. Max 5 pairs - prioritize most valuable
7. Max 5 decisions - only significant architectural choices
8. If you cannot find a meaningful insight for a conclusion, still include with insight: null
9. NEVER include process descriptions ("explored", "searched", "looked at")
10. English only, no emojis
11. Use prefixes "CONCLUSION: " and "INSIGHT: " in the strings

CHARACTER LIMITS (strict - for embedding optimization):
- system_name: 2-5 words (e.g. "Retry Queue", "Webhook Delivery System")
- summary: 150-200 characters MAX (front-loaded with tech name, NO meta-language)
- Each aspect: 2-4 words (e.g. "Job State Model", "Backoff Strategy")
- Each conclusion: max 150 characters (including "CONCLUSION: " prefix)
- Each insight: max 150 characters (including "INSIGHT: " prefix)
- Each decision aspect: 2-4 words
- Each decision choice: max 100 characters
- Each decision reason: max 150 characters
If content exceeds limit, prioritize SPECIFICITY over completeness.
Truncate gracefully - never cut mid-word or mid-path.
</output_format>

<validation>
Before responding, verify:
- Did I include a system_name that identifies the PARENT system?
- Is system_name a specific proper noun, NOT generic like "System" or "Code"?
- Is the summary 150-200 chars, front-loaded with technology name, NO meta-language?
- Does each knowledge_pair include an 'aspect' field MORE SPECIFIC than system_name?
- Does each CONCLUSION contain a specific file path or value?
- Is each INSIGHT directly related to its paired CONCLUSION?
- Does each INSIGHT add something NOT explicitly in the input?
- Would a new developer find the pairs useful without seeing the original session?
- Did I avoid process descriptions?
- Are the decisions about significant architectural choices?
- Does each decision include a specific 'aspect' field?
- Are ALL entries within character limits?
</validation>

Return ONLY valid JSON, no markdown code blocks, no explanation.`;

  debugLLM('extractReasoningAndDecisions', `Analyzing formatted steps, ${formattedSteps.length} chars`);

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0].type === 'text' ? response.content[0].text : '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);

    if (!jsonMatch) {
      console.error('[LLM-EXTRACTOR] No JSON in response');
      return { system_name: null, summary: null, reasoning_trace: [], decisions: [] };
    }

    // Try to parse JSON, with repair attempts for common Haiku formatting issues
    let result: HaikuExtractionResponse;

    try {
      result = JSON.parse(jsonMatch[0]) as HaikuExtractionResponse;
    } catch (parseError) {
      // Common fixes: trailing commas, unescaped newlines in strings
      let repaired = jsonMatch[0]
        .replace(/,\s*}/g, '}')  // trailing comma before }
        .replace(/,\s*]/g, ']')  // trailing comma before ]
        .replace(/\n/g, '\\n')   // unescaped newlines
        .replace(/\r/g, '\\r')   // unescaped carriage returns
        .replace(/\t/g, '\\t');  // unescaped tabs

      try {
        result = JSON.parse(repaired) as HaikuExtractionResponse;
      } catch (repairError) {
        // Last resort: try to extract individual fields
        const pairsMatch = jsonMatch[0].match(/"knowledge_pairs"\s*:\s*\[([\s\S]*?)\]/);
        if (pairsMatch) {
          try {
            const pairs = JSON.parse(`[${pairsMatch[1].replace(/,\s*$/, '')}]`);
            const systemMatch = jsonMatch[0].match(/"system_name"\s*:\s*"([^"]+)"/);
            const extractedSystemName = systemMatch ? systemMatch[1] : undefined;
            result = { system_name: extractedSystemName, knowledge_pairs: pairs, decisions: [] };
          } catch (fallbackError) {
            console.error('[LLM-EXTRACTOR] JSON parse failed');
            throw parseError;
          }
        } else {
          console.error('[LLM-EXTRACTOR] JSON parse failed');
          throw parseError;
        }
      }
    }

    // Extract system_name (parent anchor for all chunks)
    const systemName = result.system_name || null;

    // Keep knowledge_pairs as objects (with aspect for semantic search)
    let reasoningTrace: Array<{ aspect?: string; tags?: string; conclusion: string; insight: string | null }> = [];

    if (result.knowledge_pairs && result.knowledge_pairs.length > 0) {
      // New format: keep as objects with aspect (fall back to tags for backwards compat)
      reasoningTrace = result.knowledge_pairs.map(pair => ({
        aspect: pair.aspect || pair.tags || '',  // Prefer aspect, fallback to tags
        tags: pair.tags,  // Keep for backwards compat
        conclusion: pair.conclusion || '',
        insight: pair.insight || null,
      }));
      debugLLM('extractReasoningAndDecisions', `Extracted system_name="${systemName}", ${result.knowledge_pairs.length} pairs, ${result.decisions?.length || 0} decisions`);
    } else if (result.reasoning_trace) {
      // Backwards compatibility: old format with flat string array - wrap in objects
      reasoningTrace = result.reasoning_trace.map(entry => ({
        aspect: '',  // No aspect in old format
        conclusion: entry,
        insight: null,
      }));
      debugLLM('extractReasoningAndDecisions', `Extracted ${reasoningTrace.length} traces (old format), ${result.decisions?.length || 0} decisions`);
    }

    return {
      system_name: systemName,
      summary: result.summary || null,
      reasoning_trace: reasoningTrace,
      decisions: result.decisions || [],
    };
  } catch (error) {
    debugLLM('extractReasoningAndDecisions', `Error: ${String(error)}`);
    return { system_name: null, summary: null, reasoning_trace: [], decisions: [] };
  }
}

// ============================================
// SHOULD UPDATE MEMORY (Memory editing decision)
// Reference: docs/changing_memories.md
// ============================================

/**
 * Evolution step in memory history
 */
export interface EvolutionStep {
  summary: string;
  date: string;
}

/**
 * Mapping entry for superseded decisions
 */
export interface SupersededMapping {
  old_index: number;
  replaced_by_choice: string;
  replaced_by_reason: string;
}

/**
 * Result from shouldUpdateMemory decision
 */
export interface ShouldUpdateResult {
  should_update: boolean;
  reason: string;
  superseded_mapping: SupersededMapping[];
  condensed_old_reasoning: string | null;
  evolution_summary: string | null;
  consolidated_evolution_steps?: EvolutionStep[];
}

/**
 * Existing memory structure (from API match response)
 */
export interface ExistingMemory {
  id: string;
  goal?: string | null;
  decisions: Array<{ tags?: string; choice: string; reason: string; date?: string; active?: boolean }>;
  reasoning_trace: ReasoningTraceEntry[];
  evolution_steps: EvolutionStep[];
  files_touched: string[];
}

/**
 * Session context for update decision
 */
export interface SessionContext {
  task_type: 'information' | 'planning' | 'implementation';
  original_query: string;
  files_touched: string[];
}

/**
 * Check if shouldUpdateMemory is available
 */
export function isShouldUpdateAvailable(): boolean {
  return !!process.env.ANTHROPIC_API_KEY || !!process.env.GROV_API_KEY;
}

/**
 * Decide if a memory should be updated based on new session data
 * Called when a match is found before sync
 *
 * Handles 5 tasks in one Haiku call:
 * 1. should_update decision (boolean + reason)
 * 2. superseded_mapping (which old decisions are replaced by which new ones)
 * 3. condensed_old_reasoning (max 200 chars for reasoning_evolution)
 * 4. evolution_summary (200-250 chars for evolution_steps)
 * 5. consolidated_evolution_steps (only if > 10 entries, CONDITIONAL)
 *
 * @param existingMemory - The memory that was matched
 * @param newData - Extracted reasoning and decisions from current session
 * @param sessionContext - Task type, original query, files touched
 * @returns Decision result with all transformation data
 */
/**
 * Build the prompt for shouldUpdateMemory
 * Structured with XML tags for clear task separation
 */
function buildShouldUpdatePrompt(
  existingMemory: ExistingMemory,
  newData: ExtractedReasoningAndDecisions,
  sessionContext: SessionContext,
  needsConsolidation: boolean,
  evolutionCount: number
): string {
  // Format existing decisions with indices
  const formattedDecisions = existingMemory.decisions
    .map((d, i) => `[${i}] ${d.choice} (${d.active !== false ? 'active' : 'inactive'}): ${d.reason}`)
    .join('\n') || 'None';

  // Format existing reasoning trace (limit to 10)
  const formattedReasoning = existingMemory.reasoning_trace
    .slice(0, 10)
    .join('\n') || 'None';

  // Format evolution steps
  const formattedEvolution = existingMemory.evolution_steps
    .map(e => `- ${e.date}: ${e.summary}`)
    .join('\n') || 'No evolution history yet';

  // Format new decisions
  const formattedNewDecisions = newData.decisions
    .map(d => `- ${d.choice}: ${d.reason}`)
    .join('\n') || 'None extracted';

  // Format new reasoning (limit to 5)
  const formattedNewReasoning = newData.reasoning_trace
    .slice(0, 5)
    .join('\n') || 'None extracted';

  // Build output format based on whether consolidation is needed
  const outputFormat = needsConsolidation
    ? `{
  "should_update": boolean,
  "reason": "1-2 sentence explanation of your decision",
  "superseded_mapping": [{"old_index": number, "replaced_by_choice": "string", "replaced_by_reason": "string"}] or [],
  "condensed_old_reasoning": "string max 200 chars" or null,
  "evolution_summary": "string 200-250 chars" or null,
  "consolidated_evolution_steps": [{"summary": "...", "date": "YYYY-MM-DD"}, ...]
}`
    : `{
  "should_update": boolean,
  "reason": "1-2 sentence explanation of your decision",
  "superseded_mapping": [{"old_index": number, "replaced_by_choice": "string", "replaced_by_reason": "string"}] or [],
  "condensed_old_reasoning": "string max 200 chars" or null,
  "evolution_summary": "string 200-250 chars" or null
}`;

  // Build consolidation section (Task 5) - only if needed
  // Defined here to maintain task order in code: 1, 2, 3, 4, then 5
  const consolidationSection = needsConsolidation ? `
<task_5_consolidation>
═══════════════════════════════════════════════════════════════
TASK 5: CONSOLIDATION REQUIRED
═══════════════════════════════════════════════════════════════

Current evolution_steps has ${evolutionCount} entries (maximum is 10).

You MUST consolidate the OLDEST 3-5 entries into 1-2 summary entries.
Keep the NEWEST entries unchanged.

Current evolution_steps:
${existingMemory.evolution_steps.map((e, i) => `[${i}] ${e.date}: ${e.summary}`).join('\n')}

Rules:
1. Merge entries [0] to [3] or [4] into 1-2 summary entries
2. Keep entries [5] onwards unchanged
3. Each summary should capture the key transitions, not every detail
4. Preserve dates - use the earliest date for consolidated entries

Return the FULL consolidated array in consolidated_evolution_steps.
</task_5_consolidation>
` : '';

  return `<role>
You are a Memory Update Analyst for Grov, a coding assistant that maintains team knowledge.

Your job is to analyze whether an existing memory should be UPDATED based on new session data, or if the new session is just a query about existing knowledge (SKIP).

You have ${needsConsolidation ? '5' : '4'} tasks to complete. Read all instructions carefully before responding.
</role>

<context>
WHAT IS A MEMORY?
A memory stores knowledge from past coding sessions: decisions made, reasoning discovered, and how the project evolved over time.

WHY UPDATE MATTERS:
- UPDATE when: user made real changes, switched approaches, or discovered new information
- SKIP when: user just asked questions about existing knowledge without changing anything

THE PROBLEM WE SOLVE:
User asks "Why did we choose JWT?" then says "Ok I understand" = SKIP (just a question)
User says "Let's switch from JWT to sessions" then confirms "Ok let's do it" = UPDATE (real change)
</context>

<existing_memory>
<goal>${existingMemory.goal || 'Not specified'}</goal>

<decisions>
${formattedDecisions}
</decisions>

<reasoning_trace>
${formattedReasoning}
</reasoning_trace>

<evolution_steps>
${formattedEvolution}
</evolution_steps>

<files_in_memory>
${existingMemory.files_touched.slice(0, 10).join(', ') || 'None'}
</files_in_memory>
</existing_memory>

<new_session_data>
<task_type>${sessionContext.task_type}</task_type>
<original_query>${sessionContext.original_query}</original_query>

<files_touched_in_session>
${sessionContext.files_touched.join(', ') || 'None'}
</files_touched_in_session>

<extracted_decisions>
${formattedNewDecisions}
</extracted_decisions>

<extracted_reasoning>
${formattedNewReasoning}
</extracted_reasoning>
</new_session_data>

<task_1_should_update>
═══════════════════════════════════════════════════════════════
TASK 1: Decide should_update (boolean) and provide reason
═══════════════════════════════════════════════════════════════

<strong_signals>
RETURN should_update: true IF ANY of these STRONG signals are present:

STRONG SIGNAL A - Files were modified:
If files_touched_in_session is NOT empty, code was changed. Real changes must be recorded.

STRONG SIGNAL B - Decisions are OPPOSITE or ALTERNATIVE:
Compare extracted_decisions with existing decisions.
OPPOSITE/ALTERNATIVE means:
- They solve the SAME problem (e.g., both about authentication)
- But use DIFFERENT approach (e.g., JWT vs sessions)
- Choosing one means NOT using the other

Example OPPOSITE: "Use JWT" vs "Use sessions" = OPPOSITE (both auth, different approach)
Example NOT OPPOSITE: "Use JWT" vs "JWT with refresh tokens" = REFINEMENT (same approach, more detail)
</strong_signals>

<weak_signals>
WEAK SIGNALS (require combination):
- task_type is "planning" AND decisions cover a NEW topic not in existing memory
- User confirmed a proposed change (patterns: "ok let's do", "yes", "da", "hai", "mergem cu")
  BUT confirmation must be IN CONTEXT of a change proposal, not just acknowledgment.
</weak_signals>

<false_criteria>
RETURN should_update: false IF:

KEY DISTINCTION - Who introduced the topic?

If the assistant ALREADY explained or decided something, and the user is
asking ABOUT that explanation, this is clarifying Q&A, not new work.

CLEAR FALSE SIGNAL:
task_type is "information" AND files_touched_in_session is empty:
- The user was asking questions or seeking clarification
- No code was modified (only edit/write counts, not read)
- User is asking about what was ALREADY explained:
  - Confirmation: "Are you sure about X?"
  - Clarification: "Did you mean Y?"
  - Understanding: "Does this also work for Z?"
- These are NOT new decisions - just questions about existing explanations
- should_update: false

ALSO FALSE:
- extracted_decisions are REFORMULATIONS of existing (same meaning, different words)
- No NEW options introduced by user - just explaining existing decisions
</false_criteria>
</task_1_should_update>

<task_2_superseded_decisions>
═══════════════════════════════════════════════════════════════
TASK 2: Identify superseded decisions with replacement mapping
═══════════════════════════════════════════════════════════════

ONLY IF should_update = true:

For each existing decision, check if ANY new decision SUPERSEDES it.
Return a MAPPING that includes the replacement details.

<definition>
WHAT DOES "SUPERSEDED" MEAN?

A decision is SUPERSEDED only when ALL these conditions are true:

1. SAME DOMAIN: Both decisions address the SAME technical area:
   - Authentication: JWT, sessions, OAuth, API keys
   - Database: PostgreSQL, MySQL, MongoDB, SQLite
   - Caching: Redis, Memcached, in-memory
   - Storage: local files, S3, cloud storage
   - Framework: React, Vue, Angular

2. MUTUALLY EXCLUSIVE: Choosing one means NOT using the other.
   You cannot use both solutions simultaneously for the same purpose.

3. EXPLICIT REPLACEMENT: The new decision clearly replaces the old approach,
   not just adds to it or refines it.
</definition>

<protections>
WHAT IS NOT SUPERSEDED (IMPORTANT)

DO NOT mark as superseded if:

1. DIFFERENT DOMAINS:
   - "Use PostgreSQL" and "Use Redis for caching" = DIFFERENT domains
   - Database storage ≠ caching layer. Both can coexist.

2. REFINEMENT, not replacement:
   - "Use JWT" → "Use JWT with refresh tokens" = REFINEMENT
   - Same approach, more detail. NOT superseded.

3. ADDITION, not replacement:
   - "Add rate limiting" does NOT supersede "Use JWT"
   - Different concerns, both remain active.

4. UNCERTAIN CONNECTION:
   - If you're not 100% sure they're the same domain → DO NOT SUPERSEDE
   - Missing a supersede = minor issue
   - Wrong supersede = corrupts history (worse!)

DEFAULT: If uncertain, return empty mapping. Be conservative.
</protections>

<output_format_task2>
Return superseded_mapping as array of objects:

superseded_mapping: [
  {
    "old_index": 0,
    "replaced_by_choice": "Use sessions",
    "replaced_by_reason": "Better for long-running operations"
  }
]

If no decisions are superseded: return empty array []
If should_update = false: return empty array []
</output_format_task2>

<examples_task2>
EXAMPLE A - SUPERSEDED (same domain, opposite approach):
existing: [0] "Use JWT for authentication"
new: "Use session-based auth with Redis"
→ SUPERSEDED: same domain (auth), mutually exclusive
→ superseded_mapping: [{"old_index": 0, "replaced_by_choice": "Use session-based auth with Redis", "replaced_by_reason": "Better for long-running operations"}]

EXAMPLE B - NOT SUPERSEDED (different domains):
existing: [0] "Use PostgreSQL for main database"
new: "Add Redis for caching"
→ NOT SUPERSEDED: different domains (database vs caching)
→ superseded_mapping: []

EXAMPLE C - NOT SUPERSEDED (refinement):
existing: [0] "Use JWT tokens"
new: "Use JWT with 1hr access and 7day refresh tokens"
→ NOT SUPERSEDED: refinement of same approach
→ superseded_mapping: []

EXAMPLE D - NOT SUPERSEDED (addition):
existing: [0] "Use PostgreSQL", [1] "Use Express.js"
new: "Add input validation with Zod"
→ NOT SUPERSEDED: new concern, doesn't replace existing
→ superseded_mapping: []

EXAMPLE E - MULTIPLE SUPERSEDED:
existing: [0] "Use JWT", [1] "Store tokens in localStorage"
new: "Use session cookies", "Store session ID in httpOnly cookie"
→ superseded_mapping: [
    {"old_index": 0, "replaced_by_choice": "Use session cookies", "replaced_by_reason": "Server-side session management"},
    {"old_index": 1, "replaced_by_choice": "Store session ID in httpOnly cookie", "replaced_by_reason": "More secure than localStorage"}
  ]

EXAMPLE F - UNCERTAIN (be conservative):
existing: [0] "Use MongoDB"
new: "Consider PostgreSQL for better relational queries"
→ UNCERTAIN: "consider" suggests exploration, not decision
→ superseded_mapping: []
</examples_task2>

</task_2_superseded_decisions>

<task_3_condense_reasoning>
═══════════════════════════════════════════════════════════════
TASK 3: Condense old reasoning (max 200 characters)
═══════════════════════════════════════════════════════════════

ONLY IF should_update = true:

<purpose_task3>
The existing reasoning_trace will be OVERWRITTEN with new reasoning.
Before it's lost forever, you must preserve the most valuable insights
in a condensed form (max 200 chars) for historical context.

This condensed version will be stored in reasoning_evolution array
so users can understand past thinking even after updates.
</purpose_task3>

<what_to_include>
Prioritize in this order:

1. KEY TECHNICAL DECISIONS and their rationale
   - "JWT chosen for stateless auth"
   - "PostgreSQL for ACID compliance"

2. CONSTRAINTS or LIMITATIONS discovered
   - "API rate limit 100req/min"
   - "Browser storage max 5MB"

3. TRADE-OFFS that were considered
   - "Chose simplicity over performance"

4. NON-OBVIOUS INSIGHTS that would be hard to rediscover
   - "Edge case: empty arrays cause crash"
   - "Must call init() before connect()"
</what_to_include>

<what_to_exclude>
- Generic statements ("Implemented feature")
- Process descriptions ("User asked about X")
- Obvious facts that anyone could infer from code
- Temporary debugging notes
</what_to_exclude>

<format_guidelines_task3>
- Use concise phrases, not full sentences
- Separate distinct insights with periods
- Abbreviate common terms (auth, config, impl)
- Focus on WHAT and WHY, not HOW
</format_guidelines_task3>

<examples_task3>
GOOD: "JWT with 1hr/7d expiry for offline CLI. Device flow for OAuth. No secrets in localStorage."
GOOD: "PostgreSQL chosen over MongoDB for relational queries. Indexes on user_id, created_at."
BAD: "We implemented authentication" (too vague, no insight)
BAD: "The user wanted to know about JWT" (process, not knowledge)
</examples_task3>

IF should_update = false: return null
</task_3_condense_reasoning>

<task_4_evolution_summary>
═══════════════════════════════════════════════════════════════
TASK 4: Generate evolution summary (200-250 characters)
═══════════════════════════════════════════════════════════════

ONLY IF should_update = true:

<purpose_task4>
This summary describes WHAT CHANGED in this update.
It will be added to evolution_steps to create a timeline of how
the memory evolved over time.

Future readers will scan these summaries to understand the journey
from initial implementation to current state.
</purpose_task4>

<good_summary_criteria>
1. DESCRIBES THE CHANGE, not the session
   - YES: "Switched from JWT to sessions"
   - NO: "User discussed authentication options"

2. INCLUDES THE REASON when relevant
   - YES: "Added Redis caching for API performance"
   - NO: "Added Redis" (why?)

3. MENTIONS KEY COMPONENTS affected
   - YES: "Updated auth middleware and token validation"
   - NO: "Made some changes to auth"

4. CAPTURES THE SCOPE (what areas were touched)
   - YES: "Refactored database layer: connection pool, query caching, error handling"
   - NO: "Database changes"
</good_summary_criteria>

<structure_template>
[ACTION] [WHAT] [FOR/BECAUSE] [REASON]. [ADDITIONAL DETAILS IF SPACE].

Examples:
- "Switched from [X] to [Y] for [reason]. Updated [components]."
- "Added [feature] to [achieve goal]. Implemented [details]."
- "Fixed [problem] in [component]. Root cause was [X]."
</structure_template>

<examples_task4>
GOOD (switching): "Switched from JWT to session-based auth for long-running operations. Added Redis for session storage and updated middleware."
GOOD (adding): "Added caching layer with Redis for API optimization. Implemented 5min TTL for reads and cache invalidation on writes."
GOOD (fixing): "Fixed memory leak in WebSocket connections. Root cause was missing cleanup on disconnect. Added connection pool."
GOOD (refactoring): "Refactored user service to repository pattern. Separated data access from business logic. Added unit tests."

BAD: "Updated stuff" (too vague)
BAD: "User asked about JWT" (describes session, not change)
BAD: "Changes to authentication" (no specifics)
</examples_task4>

<length_guide>
Target: 200-250 characters
- Under 150: probably missing important details
- Over 300: probably too verbose, condense
</length_guide>

IF should_update = false: return null
</task_4_evolution_summary>
${consolidationSection}
<output_format>
Return ONLY valid JSON. No markdown, no explanation, no extra text.

IMPORTANT RULES:
- English only (translate Romanian/other languages to English in all fields)
- No emojis
- All string values in English

${outputFormat}
</output_format>

<examples>
EXAMPLE 1 - Should UPDATE (files modified):
Input: task_type=implementation, files_touched=["src/auth.ts"], query="Fix auth bug"
Output: {"should_update": true, "reason": "Files were modified in implementation session", "superseded_mapping": [], "condensed_old_reasoning": "Initial JWT implementation", "evolution_summary": "Fixed authentication bug in token validation"}

EXAMPLE 2 - Should UPDATE (opposite decision):
Input: task_type=planning, query="Let's switch to sessions instead of JWT", existing=[{choice:"Use JWT"}], new=[{choice:"Use sessions"}]
Output: {"should_update": true, "reason": "User switched from JWT to sessions - opposite approaches", "superseded_mapping": [{"old_index": 0, "replaced_by_choice": "Use sessions", "replaced_by_reason": "Better session management for long operations"}], "condensed_old_reasoning": "JWT for stateless CLI auth with refresh tokens", "evolution_summary": "Switched from JWT to session-based authentication"}

EXAMPLE 3 - Should SKIP (pure question):
Input: task_type=information, query="Why did we choose JWT?", files_touched=[]
Output: {"should_update": false, "reason": "Pure information query about existing decision - no changes", "superseded_mapping": [], "condensed_old_reasoning": null, "evolution_summary": null}

EXAMPLE 4 - Should SKIP (acknowledgment):
Input: task_type=information, query="Ok I understand now", files_touched=[]
Output: {"should_update": false, "reason": "User acknowledged explanation but did not confirm any change", "superseded_mapping": [], "condensed_old_reasoning": null, "evolution_summary": null}
</examples>`;
}

export async function shouldUpdateMemory(
  existingMemory: ExistingMemory,
  newData: ExtractedReasoningAndDecisions,
  sessionContext: SessionContext
): Promise<ShouldUpdateResult> {
  const client = getAnthropicClient();

  // Check if evolution_steps consolidation is needed
  const evolutionCount = existingMemory.evolution_steps?.length || 0;
  const needsConsolidation = evolutionCount > 10;

  // Build the prompt with all context
  const prompt = buildShouldUpdatePrompt(
    existingMemory,
    newData,
    sessionContext,
    needsConsolidation,
    evolutionCount
  );

  debugLLM('shouldUpdateMemory', `Analyzing memory update (needsConsolidation=${needsConsolidation})`);

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: needsConsolidation ? 1500 : 800,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0].type === 'text' ? response.content[0].text : '';

    // Try to parse JSON from response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error('[HAIKU] No JSON in response');
      return createFallbackResult(sessionContext);
    }

    // Parse and validate response
    let result: ShouldUpdateResult;
    try {
      result = JSON.parse(jsonMatch[0]) as ShouldUpdateResult;
    } catch (parseErr) {
      console.error('[HAIKU] JSON parse failed');
      return createFallbackResult(sessionContext);
    }

    // Ensure required fields have defaults
    result.should_update = result.should_update ?? false;
    result.reason = result.reason ?? 'No reason provided';
    result.superseded_mapping = result.superseded_mapping ?? [];
    result.condensed_old_reasoning = result.condensed_old_reasoning ?? null;
    result.evolution_summary = result.evolution_summary ?? null;

    // Decision stored in result - logged by cloud-sync.ts

    debugLLM('shouldUpdateMemory', `Result: should_update=${result.should_update}, reason="${result.reason.substring(0, 50)}"`);

    return result;

  } catch (error) {
    console.error('[HAIKU] Error:', String(error));
    return createFallbackResult(sessionContext);
  }
}

/**
 * Create fallback result when Haiku call fails
 * Default: do NOT update to avoid data loss
 */
function createFallbackResult(sessionContext: SessionContext): ShouldUpdateResult {
  // If files were touched, likely a real change - lean toward update
  const hasFiles = sessionContext.files_touched.length > 0;

  return {
    should_update: hasFiles,
    reason: hasFiles
      ? 'Fallback: files modified, assuming update needed'
      : 'Fallback: no files modified, skipping update',
    superseded_mapping: [],
    condensed_old_reasoning: null,
    evolution_summary: hasFiles ? 'Session with file modifications' : null,
  };
}
