// Haiku extraction for Cursor
// Haiku extraction service for Cursor data
// Handles: extraction + shouldUpdateMemory decisions

import Anthropic from '@anthropic-ai/sdk';
import type { CursorExtractRequest } from '../validators/cursor-format.js';

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY not configured');
    }
    client = new Anthropic({ apiKey });
  }
  return client;
}

// TODO: add retry logic
async function callHaiku(maxTokens: number, prompt: string): Promise<string | null> {
  try {
    const response = await getClient().messages.create({
      model: HAIKU_MODEL,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    });
    const block = response.content[0];
    return block?.type === 'text' ? block.text : null;
  } catch {
    return null;
  }
}

// Extraction output
export interface ExtractedData {
  system_name: string | null;
  goal: string | null;
  summary: string | null;
  task_type: 'information' | 'planning' | 'implementation';
  reasoning_trace: Array<{ aspect?: string; conclusion: string; insight: string | null }>;
  decisions: Array<{ aspect?: string; choice: string; reason: string }>;
  files_touched: string[];
}

// ============================================
// SHOULD UPDATE MEMORY TYPES
// Ported from local proxy for memory editing
// ============================================

export interface EvolutionStep {
  summary: string;
  date: string;
}

export interface SupersededMapping {
  old_index: number;
  replaced_by_choice: string;
  replaced_by_reason: string;
}

export interface ShouldUpdateResult {
  should_update: boolean;
  reason: string;
  superseded_mapping: SupersededMapping[];
  condensed_old_reasoning: string | null;
  evolution_summary: string | null;
  consolidated_evolution_steps?: EvolutionStep[];
}

export interface SessionContext {
  task_type: 'information' | 'planning' | 'implementation';
  original_query: string;
  files_touched: string[];
}

export async function extractFromCursorData(req: CursorExtractRequest): Promise<ExtractedData> {
  const toolNames = req.toolCalls.map(t => t.name).join(', ') || 'none';

  // Determine files touched from tool calls (deduplicated)
  const fileSet = new Set<string>();
  for (const tool of req.toolCalls) {
    const params = tool.params || {};
    if (typeof params.file_path === 'string') fileSet.add(params.file_path);
    if (typeof params.path === 'string') fileSet.add(params.path);
    if (typeof params.targetFile === 'string') fileSet.add(params.targetFile);
    if (typeof params.relativeWorkspacePath === 'string') fileSet.add(params.relativeWorkspacePath);
  }
  const files = Array.from(fileSet);

  const prompt = `<role>
You are a Knowledge Engineer specialized in extracting reusable team knowledge from coding sessions.

Your output will be stored permanently in team memory and used to help developers in future sessions. Poor extractions waste storage and confuse future assistants. Excellent extractions save hours of repeated investigation.
</role>

<context>
This extraction serves two purposes:
1. Help future developers understand WHAT was discovered in this codebase
2. Help future developers understand WHY certain decisions were made
</context>

<writing_rules>
ALL OUTPUT (goal, summary, conclusions, insights, decisions) MUST follow these rules:

1. COMPLETE SENTENCES: Every output field must be a grammatically complete sentence that makes sense on its own, without needing surrounding context.

2. STANDALONE MEANING: A reader should understand the sentence without reading other fields. Do not use pronouns like "it", "this", "that" without clear antecedents.

3. PLAIN LANGUAGE: Use simple, direct words. Avoid:
   - Fancy/academic words: "utilize" (use "use"), "facilitate" (use "enable"), "leverage" (use "use")
   - Filler phrases: "in order to" (use "to"), "due to the fact that" (use "because"), "at this point in time" (use "now")
   - Hedge words: "basically", "essentially", "generally speaking"

4. TIGHT SENTENCES: Remove unnecessary words. Every word must add information.
   - BAD: "This component is responsible for handling the validation of user input"
   - GOOD: "This component validates user input"

5. NO NOMINALIZATION: Use verbs, not noun forms of verbs.
   - BAD: "performs the execution of" → GOOD: "executes"
   - BAD: "handles the creation of" → GOOD: "creates"
   - BAD: "is responsible for the management of" → GOOD: "manages"
</writing_rules>

<cursor_session_data>
USER QUERY:
${req.original_query.substring(0, 1000)}

ASSISTANT THINKING:
${req.thinking.substring(0, 4000)}

ASSISTANT RESPONSE:
${req.text.substring(0, 3000)}

TOOLS USED: ${toolNames}
CURSOR MODE (hint only, analyze content): ${req.mode}
</cursor_session_data>

<instructions>

*** TASK TYPE DETECTION (CRITICAL) ***

Analyze the CONTENT to determine task_type. Do NOT trust the Cursor mode field - a user in agent mode might just ask a question.

TYPE A - Information Request (task_type = "information"):
- User is asking questions to understand something
- No files were modified
- Examples: "How does X work?", "What is Y?", "Explain Z"
- The assistant explains or describes without making changes

TYPE B - Planning/Decision Request (task_type = "planning"):
- User is discussing options, tradeoffs, architecture
- May lead to implementation later but no code changes yet
- Examples: "Should we use X or Y?", "What's the best approach?", "Let's design the system"
- The assistant helps evaluate options and make decisions

TYPE C - Implementation Request (task_type = "implementation"):
- User wants code changes, bug fixes, new features
- Files were modified (look for edit_file, write_file, search_replace in tools used)
- Examples: "Fix the bug", "Add feature X", "Update the tests"
- The assistant actively modifies code

*** GOAL GENERATION (REQUIRED) ***

Synthesize a goal from the conversation content.

DETAIL LEVEL RULES:
Goals must contain at least 2 of these specificity elements:
1. COMPONENT NAME - exact function, file, or module affected
2. ACTION TYPE - what operation (added, removed, fixed, refactored, documented)
3. TECHNICAL DETAIL - specific value, pattern, or mechanism involved
4. OUTCOME/REASON - concrete result or problem solved (not generic "improved")

VAGUE vs DETAILED:
Vague goals use abstract words that could apply to ANY task.
Detailed goals contain searchable technical specifics.

Test: If you remove the system_name, can someone understand WHAT happened?

FORMAT RULES:
- Maximum 150 characters
- Start with Technology or Component name (proper noun)
- Use past tense action verb
- Single coherent sentence

EXAMPLES:

Vague: "comment header updated for clarity"
Problem: "updated" and "for clarity" are generic - no searchable detail
Detailed: "added Cursor service identification comment with module purpose"

Vague: "authentication flow improved"
Problem: "improved" says nothing about what changed
Detailed: "authentication added JWT refresh token rotation on expiry"

Vague: "fixed database issue"
Problem: no indication of what issue or how fixed
Detailed: "fixed N+1 query in user loader by adding eager loading"

Vague: "refactored for better performance"
Problem: "better performance" is unmeasurable
Detailed: "refactored cache lookup from O(n) to O(1) using hash index"

*** GLOBAL STANDARDS FOR CODE REFERENCES ***

We want "Code Anchors" (Searchable Names), NOT "Implementation Logic" (Syntax).

1. NO SYNTAX / NO LOGIC:
   - STRICTLY FORBIDDEN: \`if\`, \`for\`, \`while\`, \`=>\`, \`return\`, \`{ }\`, \`;\`.
   - NEVER write snippet-style logic.
   - BAD: "Uses \`user.id ? save() : null\` to persist."
   - GOOD: "Uses \`save()\` method on \`User\` entity."

2. USE "NAMED ENTITIES" ONLY:
   - Treat code references as Proper Nouns.
   - Only reference Names of: Functions, Classes, File Paths, Constants, Env Vars, Config Keys.
   - Format: Wrap them in single backticks (e.g., \`auth.ts\`, \`MAX_RETRIES\`).

3. BE CONCISE:
   - Do not paste long paths if not necessary. Use relative paths.
   - BAD: \`src/features/users/controllers/auth.controller.ts\`
   - GOOD: \`auth.controller.ts\`

*** FACTUAL EXTRACTION (CRITICAL) ***

PURPOSE: All extracted knowledge must be FACTUAL STATEMENTS about the codebase, NOT descriptions of the conversation.

WHY THIS MATTERS:
- Chunks are stored as embeddings for semantic search
- "User asked about caching" has DIFFERENT embedding than "Cache uses LRU eviction"
- If we store meta-descriptions, future searches will NOT match

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
  BAD: "User asked about authentication. Explained it uses JWT tokens."
  GOOD: "Authentication uses JWT tokens with 24h expiry for stateless verification."

Example 2 - Caching explanation:
  BAD: "Explained why JavaScript Map was chosen for the LRU cache."
  GOOD: "LRU Cache uses JavaScript Map because Map guarantees insertion order."

Example 3 - Architecture discussion:
  BAD: "Discussed the Circuit Breaker pattern and its three states."
  GOOD: "Circuit Breaker implements finite state machine with CLOSED, OPEN, HALF_OPEN states."

MENTAL MODEL: Ask yourself "If I remove all context about WHO asked and WHEN, what FACTUAL KNOWLEDGE about the CODE remains?"

Transform pattern:
1. Identify the SUBJECT (component, function, pattern)
2. Identify the BEHAVIOR (what it does, how it works)
3. Identify the IMPLEMENTATION (specific details, values, files)
4. Write: "[SUBJECT] [BEHAVIOR] [IMPLEMENTATION]"

*** TYPE A: CONCLUSIONS (Factual Findings) ***

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

Format: "CONCLUSION: [Code Anchor Subject] performs [Action] using [Code Anchor Object/Value]"

*** TYPE B: INSIGHTS (Architectural Analysis) ***

Rules for High-Quality Insights:

1. Name the Pattern/Trade-off:
   - Use standard terminology: "Singleton", "Lazy Loading", "Race Condition", "O(N) Complexity", "Dependency Injection".
   - BAD: "This is good for organizing code."
   - GOOD: "Implements Dependency Injection to decouple storage logic."

2. Explain the "Hard" Consequence:
   - Focus on: Memory, CPU, Latency, Security, Consistency, Disk I/O.
   - BAD: "It makes it faster."
   - GOOD: "Reduces I/O operations by caching \`scan_result\` in memory."

Format: "INSIGHT: Implements [Pattern Name] to optimize [Resource/Outcome] by [Specific Mechanism]"

</instructions>

<summary_rules>
FRONT-LOADING RULE:
First 7-8 words determine 80% of search match quality.
Start DIRECTLY with the main technology or system name.

WRONG: "In this session we implemented a metrics system..."
WRONG: "This memory contains information about..."
RIGHT: "Prometheus Metrics System with Counter, Gauge, Histogram primitives..."
RIGHT: "Redis caching layer with TTL expiration and LRU eviction..."

CONTENT RULES:
1. Lead with technology/system name
2. Include 2-3 key technical terms that users would search for
3. NO meta-language: ban "this memory", "discussion about", "session"
4. NO file paths (save those for conclusions)
5. Describe WHAT it is, not WHAT was done

LENGTH: 150-200 characters MAXIMUM.
</summary_rules>

<output_format>
Return a JSON object with this structure:

{
  "system_name": "[MANDATORY - 2-5 words, proper noun identifying the parent system]",
  "goal": "[MANDATORY - max 150 chars, synthesized from content, starts with Tech/Component]",
  "summary": "[150-200 chars MAX - front-loaded with tech name, NO meta-language]",
  "task_type": "[information | planning | implementation - determined from CONTENT analysis]",
  "knowledge_pairs": [
    {
      "aspect": "[2-4 words - specific component within system_name]",
      "conclusion": "CONCLUSION: [specific factual finding with file paths and values - max 150 chars]",
      "insight": "INSIGHT: [inference or pattern RELATED to this conclusion - max 150 chars]"
    }
  ],
  "decisions": [
    {
      "aspect": "[2-4 words - specific component this decision is about]",
      "choice": "[What was chosen - be specific. Max 100 chars]",
      "reason": "[Why - max 150 chars]"
    }
  ]
}

SYSTEM_NAME RULES:
- 2-5 words, specific proper noun
- Ask: "What is being built/analyzed/debugged?"
- GOOD: "Retry Queue", "JWT Authentication", "Memory Cache"
- BAD: "System", "Code", "Implementation", "Backend"
- Test: If user searches "How does [system_name] work?", this should find ALL chunks

ASPECT RULES:
- 2-4 words, MORE SPECIFIC than system_name
- Example: system_name="Retry Queue", aspects="Job State Model", "Backoff Strategy", "Failed Job Recovery"
- BAD: Same as system_name, "Implementation", "Code", "Logic"

Rules:
1. system_name is MANDATORY
2. goal is MANDATORY - synthesized from content
3. task_type is MANDATORY - from content analysis, NOT from mode field
4. Each knowledge_pair MUST have aspect, conclusion AND insight
5. Max 5 knowledge_pairs, max 5 decisions
6. NEVER include meta-language or process descriptions
7. English only, no emojis
8. Use "CONCLUSION: " and "INSIGHT: " prefixes in strings

CHARACTER LIMITS (strict):
- system_name: 2-5 words
- goal: max 150 characters
- summary: 150-200 characters
- Each aspect: 2-4 words
- Each conclusion: max 150 characters (including prefix)
- Each insight: max 150 characters (including prefix)
- Each decision choice: max 100 characters
- Each decision reason: max 150 characters
</output_format>

<validation>
Before responding, verify:
- Did I include a system_name that is a specific proper noun?
- Did I synthesize a goal (max 150 chars) starting with Tech/Component name?
- Did I determine task_type from CONTENT analysis (not from mode field)?
- Is the summary 150-200 chars, front-loaded with technology name, NO meta-language?
- Does each knowledge_pair include an aspect MORE SPECIFIC than system_name?
- Does each CONCLUSION contain a specific file path or value?
- Is each INSIGHT directly related to its paired CONCLUSION?
- Did I avoid ALL forbidden patterns and meta-language?
- Does each decision include a specific aspect field?
- Are ALL entries within character limits?
</validation>

Return ONLY valid JSON, no markdown code blocks, no explanation.`;

  // Increase token limit for more detailed prompt
  const result = await callHaiku(2000, prompt);
  if (!result) {
    return {
      system_name: null,
      goal: null,
      summary: null,
      task_type: 'information',
      reasoning_trace: [],
      decisions: [],
      files_touched: files,
    };
  }

  try {
    const match = result.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON found');

    const parsed = JSON.parse(match[0]) as Record<string, unknown>;

    // Handle both knowledge_pairs (new format) and reasoning_trace (old format)
    const knowledgePairs = Array.isArray(parsed.knowledge_pairs) ? parsed.knowledge_pairs : parsed.reasoning_trace;

    return {
      system_name: typeof parsed.system_name === 'string' ? parsed.system_name : null,
      goal: typeof parsed.goal === 'string' ? parsed.goal : null,
      summary: typeof parsed.summary === 'string' ? parsed.summary : null,
      task_type: ['information', 'planning', 'implementation'].includes(parsed.task_type as string)
        ? (parsed.task_type as 'information' | 'planning' | 'implementation')
        : 'information',
      reasoning_trace: Array.isArray(knowledgePairs)
        ? knowledgePairs.map((r: Record<string, unknown>) => ({
            aspect: typeof r.aspect === 'string' ? r.aspect : undefined,
            conclusion: typeof r.conclusion === 'string' ? r.conclusion : '',
            insight: typeof r.insight === 'string' ? r.insight : null,
          }))
        : [],
      decisions: Array.isArray(parsed.decisions)
        ? parsed.decisions.map((d: Record<string, unknown>) => ({
            aspect: typeof d.aspect === 'string' ? d.aspect : undefined,
            choice: typeof d.choice === 'string' ? d.choice : '',
            reason: typeof d.reason === 'string' ? d.reason : '',
          }))
        : [],
      files_touched: files,
    };
  } catch {
    return {
      system_name: null,
      goal: null,
      summary: null,
      task_type: 'information',
      reasoning_trace: [],
      decisions: [],
      files_touched: files,
    };
  }
}

// shouldUpdateMemory types
export interface ExistingMemory {
  id: string;
  goal?: string | null;
  decisions: Array<{ tags?: string; choice: string; reason: string; date?: string; active?: boolean }>;
  reasoning_trace: Array<{ aspect?: string; conclusion: string; insight: string | null }>;
  evolution_steps: EvolutionStep[];
  files_touched: string[];
  reasoning_evolution?: Array<{ content: string; date: string }>;
}

export interface UpdateDecision {
  should_update: boolean;
  reason: string;
  evolution_summary: string | null;
}

/**
 * Build the prompt for shouldUpdateMemory
 * Ported from local proxy - structured with XML tags for clear task separation
 */
function buildShouldUpdatePrompt(
  existingMemory: ExistingMemory,
  newData: ExtractedData,
  sessionContext: SessionContext,
  needsConsolidation: boolean,
  evolutionCount: number
): string {
  // Format existing decisions with indices
  const formattedDecisions = existingMemory.decisions
    .map((d, i) => `[${i}] ${d.choice} (${d.active !== false ? 'active' : 'inactive'}): ${d.reason}`)
    .join('\n') || 'None';

  // Format existing reasoning trace (limit to 10)
  // Handle both string and object formats
  const formattedReasoning = existingMemory.reasoning_trace
    .slice(0, 10)
    .map(r => typeof r === 'string' ? r : `${r.conclusion}${r.insight ? ` | ${r.insight}` : ''}`)
    .join('\n') || 'None';

  // Format evolution steps
  const formattedEvolution = (existingMemory.evolution_steps || [])
    .map(e => `- ${e.date}: ${e.summary}`)
    .join('\n') || 'No evolution history yet';

  // Format new decisions
  const formattedNewDecisions = newData.decisions
    .map(d => `- ${d.choice}: ${d.reason}`)
    .join('\n') || 'None extracted';

  // Format new reasoning (limit to 5) - convert objects to strings
  const formattedNewReasoning = newData.reasoning_trace
    .slice(0, 5)
    .map(r => `${r.conclusion}${r.insight ? ` | ${r.insight}` : ''}`)
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
  const consolidationSection = needsConsolidation ? `
<task_5_consolidation>
TASK 5: CONSOLIDATION REQUIRED

Current evolution_steps has ${evolutionCount} entries (maximum is 10).

You MUST consolidate the OLDEST 3-5 entries into 1-2 summary entries.
Keep the NEWEST entries unchanged.

Current evolution_steps:
${(existingMemory.evolution_steps || []).map((e, i) => `[${i}] ${e.date}: ${e.summary}`).join('\n')}

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
TASK 1: Decide should_update (boolean) and provide reason

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
TASK 2: Identify superseded decisions with replacement mapping

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
   - Database storage != caching layer. Both can coexist.

2. REFINEMENT, not replacement:
   - "Use JWT" -> "Use JWT with refresh tokens" = REFINEMENT
   - Same approach, more detail. NOT superseded.

3. ADDITION, not replacement:
   - "Add rate limiting" does NOT supersede "Use JWT"
   - Different concerns, both remain active.

4. UNCERTAIN CONNECTION:
   - If you're not 100% sure they're the same domain -> DO NOT SUPERSEDE
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
-> SUPERSEDED: same domain (auth), mutually exclusive
-> superseded_mapping: [{"old_index": 0, "replaced_by_choice": "Use session-based auth with Redis", "replaced_by_reason": "Better for long-running operations"}]

EXAMPLE B - NOT SUPERSEDED (different domains):
existing: [0] "Use PostgreSQL for main database"
new: "Add Redis for caching"
-> NOT SUPERSEDED: different domains (database vs caching)
-> superseded_mapping: []

EXAMPLE C - NOT SUPERSEDED (refinement):
existing: [0] "Use JWT tokens"
new: "Use JWT with 1hr access and 7day refresh tokens"
-> NOT SUPERSEDED: refinement of same approach
-> superseded_mapping: []

EXAMPLE D - NOT SUPERSEDED (addition):
existing: [0] "Use PostgreSQL", [1] "Use Express.js"
new: "Add input validation with Zod"
-> NOT SUPERSEDED: new concern, doesn't replace existing
-> superseded_mapping: []

EXAMPLE E - MULTIPLE SUPERSEDED:
existing: [0] "Use JWT", [1] "Store tokens in localStorage"
new: "Use session cookies", "Store session ID in httpOnly cookie"
-> superseded_mapping: [
    {"old_index": 0, "replaced_by_choice": "Use session cookies", "replaced_by_reason": "Server-side session management"},
    {"old_index": 1, "replaced_by_choice": "Store session ID in httpOnly cookie", "replaced_by_reason": "More secure than localStorage"}
  ]

EXAMPLE F - UNCERTAIN (be conservative):
existing: [0] "Use MongoDB"
new: "Consider PostgreSQL for better relational queries"
-> UNCERTAIN: "consider" suggests exploration, not decision
-> superseded_mapping: []
</examples_task2>

</task_2_superseded_decisions>

<task_3_condense_reasoning>
TASK 3: Condense old reasoning (max 200 characters)

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
TASK 4: Generate evolution summary (200-250 characters)

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

/**
 * Create fallback result when Haiku call fails
 * Default: do NOT update to avoid data loss
 */
function createFallbackResult(sessionContext: SessionContext): ShouldUpdateResult {
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

export async function shouldUpdateMemory(
  existingMemory: ExistingMemory,
  newData: ExtractedData,
  sessionContext: SessionContext
): Promise<ShouldUpdateResult> {
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

  console.log(`[HAIKU] shouldUpdateMemory started (needsConsolidation=${needsConsolidation})`);

  const result = await callHaiku(needsConsolidation ? 1500 : 800, prompt);
  if (!result) {
    return createFallbackResult(sessionContext);
  }

  try {
    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return createFallbackResult(sessionContext);
    }

    // Parse and validate response
    let parsed: ShouldUpdateResult;
    try {
      parsed = JSON.parse(jsonMatch[0]) as ShouldUpdateResult;
    } catch {
      return createFallbackResult(sessionContext);
    }

    // Ensure required fields have defaults
    parsed.should_update = parsed.should_update ?? false;
    parsed.reason = parsed.reason ?? 'No reason provided';
    parsed.superseded_mapping = parsed.superseded_mapping ?? [];
    parsed.condensed_old_reasoning = parsed.condensed_old_reasoning ?? null;
    parsed.evolution_summary = parsed.evolution_summary ?? null;

    console.log(`[HAIKU] shouldUpdateMemory result: should_update=${parsed.should_update}, reason="${parsed.reason.substring(0, 50)}"`);

    return parsed;
  } catch {
    return createFallbackResult(sessionContext);
  }
}

export function isHaikuAvailable(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}
