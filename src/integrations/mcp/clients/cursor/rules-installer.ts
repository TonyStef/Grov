// Creates .cursor/rules/grov.mdc in current project

import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

const RULES_CONTENT = `---
alwaysApply: true
---

# Grov Team Memory

You have access to Grov, a team memory system. This is the source of truth for what the team has built, why decisions were made, and how systems work.

## Tools

grov_preview - fetches relevant memories. Call at START of every conversation.
grov_expand - gets full details for memories by index from preview.
grov_save - records your work after completing the request.
grov_decide_update - called only when grov_save returns needs_decision: true.

## Order of Operations

1. Call grov_preview FIRST, before any other action
   - context: user's question
   - mode: "agent" | "planning" | "ask" based on your current mode

2. If relevant memories found, call grov_expand with indices

3. Do your work using memory content as guidance

4. Call grov_save when complete:
   - goal: what was accomplished (max 150 chars)
   - original_query: user's request
   - summary: brief description for search (max 200 chars)
   - reasoning_trace: array of {conclusion, insight} (max 5)
   - decisions: array of {choice, reason} (max 5)
   - files_touched: file paths
   - mode: your current mode

5. If grov_save returns needs_decision: true, call grov_decide_update:
   - decision: "update" if new knowledge added, "skip" if nothing new
   - reason: brief explanation

## Decision Guidelines

UPDATE when:
- Files were modified
- New decisions were made
- New conclusions were reached

SKIP when:
- Only explained existing knowledge
- No changes or new decisions
`;

export async function installRulesIfNeeded(): Promise<void> {
  const projectPath = process.cwd();
  const rulesDir = join(projectPath, '.cursor', 'rules');
  const rulesFile = join(rulesDir, 'grov.mdc');

  // Skip if already exists
  if (existsSync(rulesFile)) {
    return;
  }

  // Create directory if needed
  if (!existsSync(rulesDir)) {
    mkdirSync(rulesDir, { recursive: true });
  }

  // Write rules file
  writeFileSync(rulesFile, RULES_CONTENT);
}
