// Decisions list component - Shows key decisions made during the task

import type { Decision } from '@grov/shared';

interface DecisionsListProps {
  decisions: Decision[];
}

export function DecisionsList({ decisions }: DecisionsListProps) {
  if (decisions.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-bg-1 p-4">
        <h3 className="mb-3 font-medium text-text-primary">Decisions</h3>
        <p className="text-sm text-text-muted">No key decisions recorded.</p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border bg-bg-1 p-4">
      <h3 className="mb-3 font-medium text-text-primary">
        Decisions
        <span className="ml-2 text-sm font-normal text-text-muted">
          ({decisions.length})
        </span>
      </h3>

      <div className="space-y-3 max-h-64 overflow-y-auto">
        {decisions.map((decision, index) => (
          <div
            key={index}
            className="rounded-md border border-border/50 bg-bg-0/50 p-3"
          >
            {/* Choice */}
            <div className="flex items-start gap-2">
              <span className="mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full bg-accent-400/20 text-xs text-accent-400">
                {index + 1}
              </span>
              <p className="text-sm font-medium text-text-primary">
                {decision.choice}
              </p>
            </div>

            {/* Reason */}
            {decision.reason && (
              <p className="mt-2 pl-6 text-xs text-text-secondary leading-relaxed">
                {decision.reason}
              </p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
