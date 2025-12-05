'use client';

import { cn } from '@/lib/utils';
import { LucideIcon } from 'lucide-react';

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description: string;
  action?: {
    label: string;
    onClick: () => void;
  };
  className?: string;
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex h-64 flex-col items-center justify-center rounded-lg border border-dashed border-border bg-bg-1/50 p-8 text-center',
        className
      )}
    >
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-bg-2">
        <Icon className="h-6 w-6 text-text-muted" />
      </div>
      <h3 className="mt-4 text-lg font-medium text-text-primary">{title}</h3>
      <p className="mt-1 text-sm text-text-muted max-w-sm">{description}</p>
      {action && (
        <button
          onClick={action.onClick}
          className="mt-4 inline-flex items-center rounded-md bg-accent-400 px-4 py-2 text-sm font-medium text-bg-0 transition-colors hover:bg-accent-500"
        >
          {action.label}
        </button>
      )}
    </div>
  );
}

interface NoTeamStateProps {
  onCreateTeam: () => void;
}

export function NoTeamState({ onCreateTeam }: NoTeamStateProps) {
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] p-8">
      <div className="flex h-16 w-16 items-center justify-center rounded-full bg-accent-400/10">
        <span className="font-mono text-2xl font-bold text-accent-400">g</span>
      </div>
      <h2 className="mt-6 text-2xl font-bold text-text-primary">
        Welcome to Grov
      </h2>
      <p className="mt-2 text-center text-text-secondary max-w-md">
        Create your first team to start capturing and sharing AI reasoning from
        your Claude Code sessions.
      </p>
      <button
        onClick={onCreateTeam}
        className="mt-6 inline-flex items-center rounded-md bg-accent-400 px-6 py-3 text-sm font-medium text-bg-0 transition-colors hover:bg-accent-500"
      >
        Create Your Team
      </button>
      <div className="mt-8 grid grid-cols-1 sm:grid-cols-3 gap-6 max-w-2xl">
        <div className="text-center">
          <div className="text-2xl font-bold text-accent-400">1</div>
          <p className="mt-1 text-sm text-text-muted">Create a team</p>
        </div>
        <div className="text-center">
          <div className="text-2xl font-bold text-accent-400">2</div>
          <p className="mt-1 text-sm text-text-muted">Enable CLI sync</p>
        </div>
        <div className="text-center">
          <div className="text-2xl font-bold text-accent-400">3</div>
          <p className="mt-1 text-sm text-text-muted">Capture reasoning</p>
        </div>
      </div>
    </div>
  );
}
