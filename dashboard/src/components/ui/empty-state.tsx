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
        'relative flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-root/50 p-12 text-center',
        className
      )}
    >
      <div className="relative mb-4">
        <div className="absolute inset-0 bg-leaf/20 rounded-xl blur-md" />
        <div className="relative flex h-14 w-14 items-center justify-center rounded-xl bg-bark border border-border">
          <Icon className="h-7 w-7 text-leaf" />
        </div>
      </div>
      <h3 className="text-lg font-semibold text-text-bright">{title}</h3>
      <p className="mt-2 text-sm text-text-calm max-w-sm">{description}</p>
      {action && (
        <button
          onClick={action.onClick}
          className="mt-6 inline-flex items-center rounded-xl bg-gradient-to-r from-sprout to-leaf px-6 py-2.5 text-sm font-semibold text-soil shadow-lg shadow-leaf/20 transition-all hover:shadow-xl hover:shadow-leaf/30"
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
      <div className="relative h-20 w-20">
        <div className="absolute inset-0 rounded-2xl bg-gradient-growth opacity-30 blur-lg animate-pulse-soft" />
        <div className="relative h-full w-full rounded-2xl bg-seed flex items-center justify-center">
          <span className="text-3xl font-bold text-bloom">g</span>
        </div>
      </div>
      <h2 className="mt-8 text-2xl font-bold text-text-bright">
        Welcome to Grov
      </h2>
      <p className="mt-3 text-center text-text-calm max-w-md">
        Create your first team to start capturing and sharing AI reasoning from
        your Claude Code sessions.
      </p>
      <button
        onClick={onCreateTeam}
        className="mt-8 inline-flex items-center rounded-xl bg-gradient-to-r from-sprout to-leaf px-8 py-3.5 text-sm font-semibold text-soil shadow-lg shadow-leaf/20 transition-all hover:shadow-xl hover:shadow-leaf/30"
      >
        Create Your Team
      </button>
      <div className="mt-10 grid grid-cols-1 sm:grid-cols-3 gap-8 max-w-2xl">
        <div className="text-center">
          <div className="flex h-10 w-10 mx-auto items-center justify-center rounded-xl bg-leaf/10 text-lg font-bold text-leaf">1</div>
          <p className="mt-2 text-sm text-text-calm">Create a team</p>
        </div>
        <div className="text-center">
          <div className="flex h-10 w-10 mx-auto items-center justify-center rounded-xl bg-leaf/10 text-lg font-bold text-leaf">2</div>
          <p className="mt-2 text-sm text-text-calm">Enable CLI sync</p>
        </div>
        <div className="text-center">
          <div className="flex h-10 w-10 mx-auto items-center justify-center rounded-xl bg-leaf/10 text-lg font-bold text-leaf">3</div>
          <p className="mt-2 text-sm text-text-calm">Capture reasoning</p>
        </div>
      </div>
    </div>
  );
}
