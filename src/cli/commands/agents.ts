// grov agents - List supported agents and setup instructions

import { getAllCliAgents, getCliAgentsByType } from '../agents/registry.js';

const green = '\x1b[32m';
const dim = '\x1b[90m';
const cyan = '\x1b[36m';
const reset = '\x1b[0m';

export function agents(): void {
  const cliAgents = getCliAgentsByType('cli');
  const ideAgents = getCliAgentsByType('ide');

  console.log('\nSupported Agents');
  console.log('================\n');

  console.log('CLI AGENTS (require proxy running)');
  console.log('──────────────────────────────────');
  for (const agent of cliAgents) {
    printAgent(agent);
  }

  console.log('IDE AGENTS (native integration, no proxy)');
  console.log('─────────────────────────────────────────');
  for (const agent of ideAgents) {
    printAgent(agent);
  }

  console.log('Quick Start');
  console.log('───────────\n');

  console.log(`${cyan}CLI AGENTS${reset} (Claude Code, Codex):`);
  console.log('  1. grov init <agent>');
  console.log('  2. grov proxy (keep running)');
  console.log('  3. Use agent in another terminal\n');

  console.log(`${cyan}IDE AGENTS${reset} (Cursor, Zed):`);
  console.log('  1. grov init <agent>');
  console.log('  2. Restart your IDE');
  console.log('  3. Use normally - grov runs automatically\n');

  console.log(`Troubleshooting: ${cyan}grov doctor <agent>${reset} for detailed checks\n`);
}

function printAgent(agent: { name: string; description: string; id: string; isConfigured: () => boolean; requirements: string[] }): void {
  const configured = agent.isConfigured();
  const statusIcon = configured ? `${green}●${reset}` : `${dim}○${reset}`;
  const statusText = configured ? `${green}Configured${reset}` : `${dim}Not configured${reset}`;

  console.log(`${statusIcon} ${agent.name} - ${agent.description}`);
  console.log(`   Status: ${statusText}`);

  if (!configured) {
    console.log(`   Setup:  grov init ${agent.id}`);
    console.log('   Requires:');
    for (const req of agent.requirements) {
      console.log(`     • ${req}`);
    }
  }

  console.log('');
}
