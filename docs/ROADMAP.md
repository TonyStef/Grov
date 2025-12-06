# Grov Roadmap

## Overview

```
Phase 1: MVP (Local)        → Prove the core loop works
Phase 2: Team Sync          → Share reasoning across developers
Phase 3: Smart Retrieval    → Semantic search, relevance scoring
Phase 4: Enterprise         → SSO, compliance, on-prem
Phase 5: Ecosystem          → Integrations, API, marketplace
```

---

## Phase 1: MVP (Local-Only)

**Goal:** Prove that capturing and injecting reasoning actually reduces exploration time.

**Status:** ✅ Complete

### Features
- [x] Design: Task-based storage (not session-based)
- [x] Design: Hook-based capture (Stop event)
- [x] Design: Hook-based injection (SessionStart + additionalContext)
- [x] `grov init` - Configure proxy
- [x] `grov proxy` - Intercept Claude Code traffic
- [x] `grov status` - Show captured tasks
- [x] LLM-powered extraction (Haiku)
- [x] Anti-drift detection

### Success Metrics
- 0 explore agents on tasks with prior context
- 80% reduction in time-to-implementation
- Token usage: 7% → <2%

### Tech Stack
- Node.js + TypeScript
- better-sqlite3
- Anthropic SDK (Haiku)
- npm/npx distribution

---

## Phase 2: Team Sync

**Goal:** Multiple developers share reasoning on the same codebase.

**Status:** ✅ Complete

### Features Implemented
- [x] Cloud sync to Supabase (Postgres)
- [x] Auto-sync on session complete
- [x] Team dashboard at [app.grov.dev](https://app.grov.dev)
- [x] GitHub OAuth authentication
- [x] Team creation and invite system
- [x] View team members' memories
- [x] Search across sessions

### Commands
```bash
grov login                    # Authenticate via GitHub
grov logout                   # Clear credentials
grov sync --enable --team ID  # Enable sync for a team
grov sync                     # Check sync status
```

### Architecture
- **API:** Fastify on Google Cloud Run (`api.grov.dev`)
- **Dashboard:** Next.js 15 on Google Cloud Run (`app.grov.dev`)
- **Database:** Supabase (Postgres + Auth + RLS)
- **Auth:** GitHub OAuth via Supabase

---

## Phase 3: Smart Retrieval

**Goal:** Don't just match by file path—understand semantic relevance.

### Features

#### Embedding-Based Search
```
User starts task: "fix the login timeout bug"

Current (Phase 1):
  → Query: WHERE files_touched LIKE '%login%' OR files_touched LIKE '%auth%'
  → Misses relevant tasks that touched different files but same concept

Phase 3:
  → Embed query: "fix the login timeout bug" → vector
  → Query: Find tasks with similar embedding vectors
  → Returns conceptually related tasks even if different files
```

#### Auto-Tagging Improvements
- Use LLM to generate semantic tags, not just file-based
- Cluster related tasks automatically
- Suggest connections: "This task is related to 3 previous tasks"

#### Relevance Scoring
```
Score each potential context injection:
- Recency: How recent was this task? (decay over time)
- File overlap: Do the files overlap with current task?
- Semantic similarity: How similar are the embeddings?
- Outcome: Was the task successful? (weight complete > partial)
- Author: Same developer? (might be more relevant)

Final score = weighted combination
Only inject top N scoring tasks
```

#### Context Window Management
- Track how much context is being injected
- Prioritize most relevant when approaching limits
- Summarize older context to fit more

### Architecture Addition
```
src/
├── retrieval/
│   ├── embeddings.ts        # Generate embeddings (OpenAI/Voyage)
│   ├── vector-store.ts      # Store/query vectors (SQLite vec or Pinecone)
│   ├── relevance-scorer.ts  # Score and rank results
│   └── context-manager.ts   # Manage injection size
```

### Tech Stack Additions
- **Embeddings:** OpenAI text-embedding-3-small or Voyage
- **Vector Store:** SQLite with vec extension (local) or Pinecone (cloud)

---

## Phase 4: Enterprise

**Goal:** Make grov deployable in large organizations with compliance requirements.

### Features

#### Single Sign-On (SSO)
- SAML 2.0 support
- OIDC support
- Integration with Okta, Azure AD, Google Workspace

#### On-Premise Deployment
```
┌─────────────────────────────────────────┐
│           Customer's Infrastructure      │
│  ┌─────────────┐     ┌─────────────┐    │
│  │  grov API   │────►│  Postgres   │    │
│  │  (Docker)   │     │  (internal) │    │
│  └─────────────┘     └─────────────┘    │
│         ▲                               │
│         │                               │
│  ┌──────┴──────┐                        │
│  │ Dev machines│                        │
│  │ (grov CLI)  │                        │
│  └─────────────┘                        │
└─────────────────────────────────────────┘
```

- Docker/Kubernetes deployment
- Helm charts
- Air-gapped installation support

#### Compliance & Security
- SOC 2 Type II certification
- GDPR compliance (data residency options)
- HIPAA compliance (for healthcare)
- Audit logging
- Data retention policies
- Encryption at rest and in transit

#### Admin Controls
- Team/organization hierarchy
- Role-based access control (RBAC)
- Usage analytics and reporting
- Cost allocation by team

#### Advanced Features
- Custom LLM endpoints (use your own Claude/GPT deployment)
- Integration with existing knowledge bases
- Webhook notifications
- API for custom integrations

---

## Phase 5: Ecosystem

**Goal:** Make grov a platform others can build on.

### Features

#### Public API
```
POST /api/v1/tasks          # Create task
GET  /api/v1/tasks          # List tasks
GET  /api/v1/tasks/:id      # Get task
POST /api/v1/search         # Semantic search
POST /api/v1/context        # Get context for a query
```

#### Integrations
- **IDE plugins:** VS Code, JetBrains, Neovim
- **CI/CD:** GitHub Actions, GitLab CI
- **Project management:** Jira, Linear, GitHub Issues
- **Documentation:** Auto-generate docs from reasoning
- **Slack/Discord:** Notifications, search from chat

#### Plugin System
```
// Example: Custom extractor plugin
export default {
  name: 'jira-linker',
  hooks: {
    afterCapture: async (task) => {
      // Extract Jira ticket IDs from task
      const tickets = extractJiraIds(task.original_query);
      // Link task to Jira
      await linkToJira(task.id, tickets);
    }
  }
}
```

#### Marketplace
- Community-built extractors
- Custom context formatters
- Integration connectors
- Shared reasoning templates

---

## Revenue Model by Phase

| Phase | Tier | Price | Features |
|-------|------|-------|----------|
| 1 | Free | $0 | Local only, unlimited |
| 2 | Pro | $20/mo | Cloud sync, unlimited tasks |
| 2 | Team | $15/seat/mo | Shared reasoning, dashboard |
| 4 | Enterprise | Custom | SSO, on-prem, compliance, SLA |

---

## Timeline (Estimated)

```
Phase 1: MVP           2-3 weeks    ← Current
Phase 2: Team Sync     4-6 weeks
Phase 3: Smart Search  3-4 weeks
Phase 4: Enterprise    8-12 weeks
Phase 5: Ecosystem     Ongoing
```

*Timelines are rough estimates and depend on validation at each phase.*

---

## Decision Points

### After Phase 1
- Does context injection actually reduce exploration?
- Is the capture quality good enough?
- What's the failure mode when wrong context is injected?

### After Phase 2
- Do teams actually share reasoning?
- What's the collaboration pattern?
- Is sync reliable enough?

### After Phase 3
- Does semantic search improve retrieval quality?
- Is the added complexity worth it?
- What embedding model works best?

### Before Phase 4
- Is there enterprise demand?
- What compliance certifications are needed?
- Build vs partner for SSO?

---

## Open Questions (Future)

1. **Multi-agent support:** How does this work with Claude's subagents?
2. **Cross-project context:** Should reasoning transfer between projects?
3. **Reasoning decay:** Should old reasoning be auto-archived?
4. **Confidence scoring:** How confident should Claude be in injected context?
5. **Feedback loop:** How do users correct bad reasoning?
6. **Other AI tools:** Support for Cursor, Copilot, etc.?
