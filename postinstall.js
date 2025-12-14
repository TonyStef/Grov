#!/usr/bin/env node

const green = '\x1b[32m';
const cyan = '\x1b[36m';
const dim = '\x1b[2m';
const reset = '\x1b[0m';
const bold = '\x1b[1m';

console.log(`
${green}✓${reset} ${bold}grov installed successfully${reset}

${dim}Sync your AI memories across your team:${reset}
  ${cyan}https://app.grov.dev${reset}

${dim}Quick start:${reset}
  ${green}grov init${reset}      Configure proxy
  ${green}grov proxy${reset}     Start capturing
  ${green}grov login${reset}     Connect to dashboard
`);
