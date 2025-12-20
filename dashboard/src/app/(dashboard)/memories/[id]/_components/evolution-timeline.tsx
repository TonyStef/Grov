// Evolution Timeline - Shows history of memory changes

import type { EvolutionStep } from '@grov/shared';
import { formatRelativeDate } from '@/lib/utils';

interface EvolutionTimelineProps {
  steps: EvolutionStep[];
}

export function EvolutionTimeline({ steps }: EvolutionTimelineProps) {
  if (!steps || steps.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-bg-1 p-6">
        <h2 className="text-lg font-semibold text-text-primary">Evolution Timeline</h2>
        <p className="mt-4 text-sm text-text-muted">No history yet</p>
      </div>
    );
  }

  // Reverse to show newest first
  const reversedSteps = [...steps].reverse();

  return (
    <div className="rounded-lg border border-border bg-bg-1 p-6">
      <h2 className="text-lg font-semibold text-text-primary">Evolution Timeline</h2>

      <div className="mt-6 space-y-0">
        {reversedSteps.map((step, index) => {
          // Determine label: Latest, Previous..., Original
          let label: string;
          if (index === 0) {
            label = 'Latest';
          } else if (index === reversedSteps.length - 1) {
            label = 'Original';
          } else {
            label = 'Previous';
          }

          const isLast = index === reversedSteps.length - 1;

          return (
            <div key={index} className="relative flex gap-4">
              {/* Timeline line and dot */}
              <div className="flex flex-col items-center">
                <div
                  className={`h-3 w-3 rounded-full ${
                    index === 0 ? 'bg-accent-400' : 'bg-bg-3'
                  }`}
                />
                {!isLast && (
                  <div className="w-0.5 flex-1 bg-border" />
                )}
              </div>

              {/* Content */}
              <div className={`flex-1 ${!isLast ? 'pb-6' : ''}`}>
                <div className="flex items-center gap-3">
                  <span
                    className={`text-xs font-medium ${
                      index === 0 ? 'text-accent-400' : 'text-text-muted'
                    }`}
                  >
                    {label}
                  </span>
                  <span className="text-xs text-text-muted">
                    {formatRelativeDate(step.date)}
                  </span>
                </div>
                <p className="mt-1 text-sm text-text-secondary leading-relaxed">
                  {step.summary}
                </p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
