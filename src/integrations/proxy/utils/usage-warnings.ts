// Usage warning display for CLI
// Shows warnings when approaching or exceeding monthly quota

import type { RecordInjectionResponse, UsageStatus } from '@grov/shared';

const SEVERITY: Record<UsageStatus, number> = {
  normal: 0,
  warning_80: 1,
  warning_100: 2,
  overage: 3,
};

// Cache: teamId -> last warned status (prevents duplicate warnings)
const warnedStatus = new Map<string, UsageStatus>();

export function handleInjectionResponse(
  response: RecordInjectionResponse | null,
  teamId: string
): void {
  if (!response) return;

  // Period reset - clear cache
  if (response.status === 'normal') {
    warnedStatus.delete(teamId);
    return;
  }

  const lastSeverity = SEVERITY[warnedStatus.get(teamId) ?? 'normal'];
  const currentSeverity = SEVERITY[response.status];

  // Only warn on escalation
  if (currentSeverity <= lastSeverity) return;

  warnedStatus.set(teamId, response.status);

  const percent = Math.round((response.current_count / response.quota) * 100);
  const usage = `${response.current_count}/${response.quota}`;

  switch (response.status) {
    case 'warning_80':
      console.log(`[grov] ⚠️  Usage at ${percent}% of monthly quota (${usage} injections)`);
      break;
    case 'warning_100':
      console.log(`[grov] ⚠️  Monthly quota reached (${usage} injections)`);
      console.log(`[grov]    Overage charges apply after 110% usage`);
      break;
    case 'overage':
      console.log(`[grov] ⚠️  Overage billing now active (${usage} injections)`);
      console.log(`[grov]    Manage usage: https://grov.dev/settings`);
      break;
  }
}
