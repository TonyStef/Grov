// Decisions list component - Shows key decisions made during the task
// Supports showing superseded decisions with expand feature

'use client';

import { useState } from 'react';
import type { Decision } from '@grov/shared';

interface DecisionsListProps {
  decisions: Decision[];
  showSuperseded?: boolean; // If true, show all including superseded with visual distinction
}

export function DecisionsList({ decisions, showSuperseded = false }: DecisionsListProps) {
  // Filter decisions based on prop
  const activeDecisions = decisions.filter(d => d.active !== false);
  const supersededDecisions = decisions.filter(d => d.active === false);

  const displayDecisions = showSuperseded ? decisions : activeDecisions;
  const hasSuperseded = supersededDecisions.length > 0;

  if (displayDecisions.length === 0) {
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
          ({activeDecisions.length}{showSuperseded && hasSuperseded ? ` + ${supersededDecisions.length} superseded` : ''})
        </span>
      </h3>

      <div className="space-y-3 max-h-80 overflow-y-auto">
        {displayDecisions.map((decision, index) => (
          <DecisionCard
            key={index}
            decision={decision}
            index={index}
            showSupersededInfo={showSuperseded}
          />
        ))}
      </div>
    </div>
  );
}

// Individual decision card with expand support
function DecisionCard({
  decision,
  index,
  showSupersededInfo
}: {
  decision: Decision;
  index: number;
  showSupersededInfo: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const isSuperseded = decision.active === false;
  const hasSupersededBy = isSuperseded && decision.superseded_by;

  return (
    <div
      className={`rounded-md border p-3 transition-colors ${
        isSuperseded
          ? 'border-border/30 bg-bg-0/30 opacity-60'
          : 'border-border/50 bg-bg-0/50'
      }`}
    >
      {/* Choice */}
      <div className="flex items-start gap-2">
        <span className={`mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full text-xs ${
          isSuperseded
            ? 'bg-text-muted/20 text-text-muted line-through'
            : 'bg-accent-400/20 text-accent-400'
        }`}>
          {index + 1}
        </span>
        <div className="flex-1 min-w-0">
          <p className={`text-sm font-medium ${
            isSuperseded ? 'text-text-muted line-through' : 'text-text-primary'
          }`}>
            {decision.choice}
          </p>

          {/* Superseded badge */}
          {isSuperseded && (
            <span className="inline-block mt-1 px-1.5 py-0.5 text-[10px] rounded bg-warning/10 text-warning">
              Superseded
            </span>
          )}
        </div>
      </div>

      {/* Reason */}
      {decision.reason && (
        <p className={`mt-2 pl-6 text-xs leading-relaxed ${
          isSuperseded ? 'text-text-muted' : 'text-text-secondary'
        }`}>
          {decision.reason}
        </p>
      )}

      {/* Date if available */}
      {decision.date && (
        <p className="mt-1 pl-6 text-[10px] text-text-muted">
          {decision.date}
        </p>
      )}

      {/* Superseded by expand section */}
      {showSupersededInfo && hasSupersededBy && (
        <div className="mt-2 pl-6">
          <button
            onClick={() => setExpanded(!expanded)}
            className="flex items-center gap-1 text-xs text-accent-400 hover:text-accent-300 transition-colors"
          >
            <svg
              className={`w-3 h-3 transition-transform ${expanded ? 'rotate-90' : ''}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
            Replaced by...
          </button>

          {expanded && decision.superseded_by && (
            <div className="mt-2 p-2 rounded bg-bg-2/50 border border-border/30 text-xs">
              <div className="font-medium text-text-primary">
                → {decision.superseded_by.choice}
              </div>
              {decision.superseded_by.reason && (
                <div className="mt-1 text-text-secondary">
                  Why: {decision.superseded_by.reason}
                </div>
              )}
              {decision.superseded_by.date && (
                <div className="mt-1 text-text-muted text-[10px]">
                  Changed: {decision.superseded_by.date}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
