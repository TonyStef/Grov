// grov proxy-status - Show active proxy sessions

import { getActiveSessionsForStatus, type SessionState } from '../lib/store.js';

export async function proxyStatus(): Promise<void> {
  const sessions = getActiveSessionsForStatus();

  if (sessions.length === 0) {
    console.log('No active proxy sessions.');
    return;
  }

  console.log(`\n=== Active Proxy Sessions (${sessions.length}) ===\n`);

  for (const session of sessions) {
    const elapsed = getElapsedTime(session.start_time);
    const goal = session.original_goal || 'No goal set';

    console.log(`Session: ${session.session_id.substring(0, 8)}...`);
    console.log(`  Status: ${session.status}`);
    console.log(`  Mode: ${session.session_mode || 'normal'}`);
    console.log(`  Goal: ${goal.substring(0, 60)}${goal.length > 60 ? '...' : ''}`);
    console.log(`  Drift: ${session.escalation_count} escalations`);
    console.log(`  Started: ${elapsed} ago`);
    console.log('');
  }
}

function getElapsedTime(startTime: string): string {
  const start = new Date(startTime).getTime();
  const now = Date.now();
  const diff = now - start;

  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  }
  return `${minutes}m`;
}
