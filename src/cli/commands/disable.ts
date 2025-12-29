// grov disable - Remove proxy configuration

import { getAgentByName } from '../../integrations/proxy/agents/index.js';

export async function disable(agentName: 'claude' | 'codex' = 'claude'): Promise<void> {
  const agent = getAgentByName(agentName);
  if (!agent) {
    console.error(`Unknown agent: ${agentName}`);
    console.error('Supported agents: claude, codex');
    process.exit(1);
  }

  const settings = agent.getSettings();
  const result = settings.setProxyEnabled(false);

  if (result.action === 'removed') {
    console.log(`Grov disabled for ${agentName}.`);
    console.log('  - Proxy configuration removed');
  } else {
    console.log(`Grov was not configured for ${agentName}.`);
  }

  console.log(`\nConfig file: ${settings.getConfigPath()}`);

  const targetName = agentName === 'claude' ? 'Anthropic' : 'OpenAI';
  console.log(`\n${agentName} will now connect directly to ${targetName}.`);
}
