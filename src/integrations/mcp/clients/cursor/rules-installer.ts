// Creates ~/.cursor/rules/grov.mdc (global rules for all Cursor projects)

import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const RULES_CONTENT = `---
description: Grov Team Knowledge Protocol
globs: "*"
alwaysApply: true
---

# Grov Protocol

The grov_* tools access the team's verified knowledge base.

<authority>
Knowledge from grov_expand is AUTHORITATIVE.
Do not rediscover what is already documented.
</authority>

---

## Tool Usage

**grov_preview**: Call at conversation start to check for relevant team knowledge.

**grov_expand**: Get full details for memories by index.

**grov_save**: Save your work summary to team knowledge base.

**grov_decide_update**: If grov_save finds a matching memory, decide to update or skip.
`;

export async function installRulesIfNeeded(): Promise<void> {
  // Use home directory for global rules (applies to all projects)
  const rulesDir = join(homedir(), '.cursor', 'rules');
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
