// Memory header component - Shows query, goal, status, user, and date

import type { Memory } from '@grov/shared';

interface MemoryHeaderProps {
  memory: Memory & {
    profile?: {
      full_name: string | null;
      avatar_url: string | null;
      email: string;
    };
  };
}

// Status badge colors
const statusColors: Record<string, string> = {
  complete: 'bg-success/20 text-success',
  question: 'bg-info/20 text-info',
  partial: 'bg-warning/20 text-warning',
  abandoned: 'bg-error/20 text-error',
};

// Check if memory was edited (has at least 1 evolution step)
function getLastActivityInfo(memory: Memory): { wasEdited: boolean; date: Date; label: string } {
  const evolutionSteps = memory.evolution_steps || [];
  const wasEdited = evolutionSteps.length > 0;

  if (wasEdited) {
    // Get last evolution step date (format: YYYY-MM-DD)
    const lastStep = evolutionSteps[evolutionSteps.length - 1];
    return {
      wasEdited: true,
      date: new Date(lastStep.date),
      label: 'Edited',
    };
  }

  return {
    wasEdited: false,
    date: new Date(memory.created_at),
    label: 'Created',
  };
}

export function MemoryHeader({ memory }: MemoryHeaderProps) {
  const displayName = memory.profile?.full_name || memory.profile?.email || 'Unknown';
  const avatarUrl = memory.profile?.avatar_url;
  const { wasEdited, date: activityDate, label: dateLabel } = getLastActivityInfo(memory);

  return (
    <div className="rounded-lg border border-border bg-bg-1 p-6">
      {/* Goal (title) - fallback to query if no goal */}
      <h1 className="text-xl font-semibold text-text-primary leading-relaxed">
        {memory.goal || memory.original_query}
      </h1>

      {/* Original query (subtitle) - max 2 lines, only show if goal exists */}
      {memory.goal && memory.original_query && (
        <p className="mt-3 text-text-secondary line-clamp-2">
          <span className="text-text-muted">Query:</span> {memory.original_query}
        </p>
      )}

      {/* Meta row */}
      <div className="mt-4 flex flex-wrap items-center gap-4 border-t border-border pt-4">
        {/* Status */}
        <span
          className={`rounded-full px-2.5 py-1 text-xs font-medium ${
            statusColors[memory.status] || 'bg-bg-2 text-text-secondary'
          }`}
        >
          {memory.status}
        </span>

        {/* Project path */}
        <div className="flex items-center gap-1.5 text-sm text-text-secondary">
          <svg
            className="h-4 w-4"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
            />
          </svg>
          <span className="font-mono text-xs">{memory.project_path}</span>
        </div>

        {/* User */}
        <div className="flex items-center gap-2 text-sm text-text-secondary">
          {avatarUrl ? (
            <img
              src={avatarUrl}
              alt={displayName}
              className="h-5 w-5 rounded-full"
            />
          ) : (
            <div className="flex h-5 w-5 items-center justify-center rounded-full bg-bg-3 text-xs">
              {displayName.charAt(0).toUpperCase()}
            </div>
          )}
          <span>{displayName}</span>
        </div>

        {/* Date - shows "Created" or "Edited" based on evolution_steps */}
        <div className="flex items-center gap-1.5 text-sm text-text-muted">
          <svg
            className="h-4 w-4"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
            />
          </svg>
          <span>{dateLabel}</span>
          <time dateTime={activityDate.toISOString()}>
            {activityDate.toLocaleDateString('en-US', {
              year: 'numeric',
              month: 'short',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            })}
          </time>
        </div>
      </div>
    </div>
  );
}
