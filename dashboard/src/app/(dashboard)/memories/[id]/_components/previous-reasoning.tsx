// Previous Reasoning Traces - Shows condensed historical reasoning
'use client';

import { useState } from 'react';
import type { ReasoningEvolutionEntry } from '@grov/shared';
import { formatDate } from '@/lib/utils';

interface PreviousReasoningProps {
  entries: ReasoningEvolutionEntry[];
}

export function PreviousReasoning({ entries }: PreviousReasoningProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  if (!entries || entries.length === 0) {
    return null;
  }

  return (
    <div className="rounded-lg border border-border bg-bg-1 p-6">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex w-full items-center justify-between text-left"
      >
        <h2 className="text-lg font-semibold text-text-primary">
          Previous Reasoning Traces
          <span className="ml-2 text-sm font-normal text-text-muted">
            ({entries.length})
          </span>
        </h2>
        <svg
          className={`h-5 w-5 text-text-muted transition-transform ${
            isExpanded ? 'rotate-180' : ''
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

      {isExpanded && (
        <div className="mt-4 space-y-4">
          {entries.map((entry, index) => (
            <ReasoningEntry key={index} entry={entry} />
          ))}
        </div>
      )}
    </div>
  );
}

function ReasoningEntry({ entry }: { entry: ReasoningEvolutionEntry }) {
  const [isOpen, setIsOpen] = useState(false);
  
  // Create preview (max 60 chars)
  const preview = entry.content.length > 60 
    ? entry.content.substring(0, 60) + '...'
    : entry.content;

  return (
    <div className="rounded-md border border-border bg-bg-2/50 p-4">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex w-full items-center justify-between text-left gap-4"
      >
        <span className="text-sm font-medium text-text-secondary truncate">
          {formatDate(entry.date)} <span className="text-text-muted font-normal">— {preview}</span>
        </span>
        <svg
          className={`h-4 w-4 text-text-muted transition-transform shrink-0 ${
            isOpen ? 'rotate-180' : ''
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

      {isOpen && (
        <p className="mt-3 text-sm text-text-muted leading-relaxed border-t border-border/50 pt-3">
          {entry.content}
        </p>
      )}
    </div>
  );
}
