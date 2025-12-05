// Reasoning trace component - Shows the step-by-step reasoning

'use client';

import { useState } from 'react';

interface ReasoningTraceProps {
  trace: string[];
}

export function ReasoningTrace({ trace }: ReasoningTraceProps) {
  const [expandedSteps, setExpandedSteps] = useState<Set<number>>(new Set([0]));

  const toggleStep = (index: number) => {
    const newExpanded = new Set(expandedSteps);
    if (newExpanded.has(index)) {
      newExpanded.delete(index);
    } else {
      newExpanded.add(index);
    }
    setExpandedSteps(newExpanded);
  };

  const expandAll = () => {
    setExpandedSteps(new Set(trace.map((_, i) => i)));
  };

  const collapseAll = () => {
    setExpandedSteps(new Set());
  };

  if (trace.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-bg-1 p-6">
        <h2 className="mb-4 text-lg font-medium text-text-primary">Reasoning Trace</h2>
        <p className="text-sm text-text-muted">No reasoning trace available.</p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border bg-bg-1 p-6">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-medium text-text-primary">
          Reasoning Trace
          <span className="ml-2 text-sm font-normal text-text-muted">
            ({trace.length} step{trace.length !== 1 ? 's' : ''})
          </span>
        </h2>
        <div className="flex gap-2">
          <button
            onClick={expandAll}
            className="text-xs text-text-secondary hover:text-text-primary transition-colors"
          >
            Expand all
          </button>
          <span className="text-text-muted">|</span>
          <button
            onClick={collapseAll}
            className="text-xs text-text-secondary hover:text-text-primary transition-colors"
          >
            Collapse all
          </button>
        </div>
      </div>

      <div className="space-y-3">
        {trace.map((step, index) => (
          <div
            key={index}
            className="rounded-md border border-border/50 bg-bg-0/50"
          >
            <button
              onClick={() => toggleStep(index)}
              className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-bg-2/50 transition-colors"
            >
              {/* Step number */}
              <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-accent-400/20 text-xs font-medium text-accent-400">
                {index + 1}
              </span>

              {/* Preview */}
              <span
                className={`flex-1 text-sm ${
                  expandedSteps.has(index)
                    ? 'text-text-primary'
                    : 'text-text-secondary truncate'
                }`}
              >
                {step.length > 100 && !expandedSteps.has(index)
                  ? step.slice(0, 100) + '...'
                  : expandedSteps.has(index)
                  ? ''
                  : step}
              </span>

              {/* Expand icon */}
              <svg
                className={`h-4 w-4 flex-shrink-0 text-text-muted transition-transform ${
                  expandedSteps.has(index) ? 'rotate-180' : ''
                }`}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M19 9l-7 7-7-7"
                />
              </svg>
            </button>

            {/* Expanded content */}
            {expandedSteps.has(index) && (
              <div className="border-t border-border/50 px-4 py-3">
                <p className="whitespace-pre-wrap text-sm text-text-secondary leading-relaxed">
                  {step}
                </p>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
