// Reasoning trace component - Shows the step-by-step reasoning

'use client';

import { useState } from 'react';

// Support all formats:
// - string (old): "CONCLUSION: text" or "INSIGHT: text"
// - old object: { step?: number; thought: string }
// - new object: { tags?: string; conclusion: string; insight?: string | null }
type TraceStep =
  | string
  | { step?: number; thought: string }
  | { tags?: string; conclusion: string; insight?: string | null };

interface ReasoningTraceProps {
  trace: TraceStep[];
}

// Check if step is the new format with tags/conclusion/insight
function isNewFormat(step: TraceStep): step is { tags?: string; conclusion: string; insight?: string | null } {
  return typeof step === 'object' && step !== null && 'conclusion' in step;
}

// Extract text from a trace step (handles all formats)
function getStepText(step: TraceStep): string {
  if (typeof step === 'string') {
    return step;
  }

  if (isNewFormat(step)) {
    // New format: combine conclusion + insight
    const parts = [step.conclusion, step.insight].filter(Boolean);
    return parts.join(' | ');
  }

  // Old object format with 'thought'
  return step.thought || '';
}

// Get tags from step (only for new format)
function getStepTags(step: TraceStep): string | undefined {
  if (isNewFormat(step)) {
    return step.tags;
  }
  return undefined;
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
        {trace.map((step, index) => {
          const text = getStepText(step);
          const tags = getStepTags(step);
          return (
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

                {/* Tags badge (if present) */}
                {tags && (
                  <span className="flex-shrink-0 rounded bg-accent-400/10 px-2 py-0.5 text-xs font-medium text-accent-400">
                    {tags}
                  </span>
                )}

                {/* Preview */}
                <span
                  className={`flex-1 text-sm ${
                    expandedSteps.has(index)
                      ? 'text-text-primary'
                      : 'text-text-secondary truncate'
                  }`}
                >
                  {text.length > 100 && !expandedSteps.has(index)
                    ? text.slice(0, 100) + '...'
                    : expandedSteps.has(index)
                    ? ''
                    : text}
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
                  {isNewFormat(step) ? (
                    <div className="space-y-2">
                      <p className="whitespace-pre-wrap text-sm text-text-secondary leading-relaxed">
                        {step.conclusion}
                      </p>
                      {step.insight && (
                        <p className="whitespace-pre-wrap text-sm text-text-muted leading-relaxed italic">
                          {step.insight}
                        </p>
                      )}
                    </div>
                  ) : (
                    <p className="whitespace-pre-wrap text-sm text-text-secondary leading-relaxed">
                      {text}
                    </p>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
