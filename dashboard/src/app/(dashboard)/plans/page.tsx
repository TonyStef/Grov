import type { Metadata } from 'next';
import Link from 'next/link';
import Image from 'next/image';
import { ClipboardList, Clock, CheckCircle2, Loader2 } from 'lucide-react';
import { createClient } from '@/lib/supabase/server';
import { getCurrentTeam } from '@/lib/queries/current-team';
import { getPlansList } from '@/lib/queries/plans';
import { getUserRoleInTeam, getTeamMembers } from '@/lib/queries/teams';
import { formatRelativeDate, getInitials } from '@/lib/utils';
import { PlansPageClient } from './_components/plans-page-client';
import type { PlanStatus } from '@grov/shared';

export const metadata: Metadata = {
  title: 'Plans',
};

interface PageProps {
  searchParams: Promise<{ status?: string }>;
}

interface StatusTab {
  value: PlanStatus | 'all';
  label: string;
}

const STATUS_TABS: StatusTab[] = [
  { value: 'all', label: 'Active' },
  { value: 'completed', label: 'Completed' },
  { value: 'archived', label: 'Archived' },
];

const PRIORITY_COLORS: Readonly<Record<string, string>> = {
  urgent: 'bg-error/10 text-error',
  high: 'bg-warning/10 text-warning',
  normal: 'bg-info/10 text-info',
  low: 'bg-text-quiet/10 text-text-quiet',
};

const STATUS_COLORS: Readonly<Record<string, string>> = {
  active: 'bg-success/10 text-success',
  completed: 'bg-leaf/10 text-leaf',
  archived: 'bg-text-quiet/10 text-text-quiet',
};

export default async function PlansPage({ searchParams }: PageProps) {
  const { status: statusParam } = await searchParams;
  const supabase = await createClient();
  const { data: { user: authUser } } = await supabase.auth.getUser();

  if (!authUser) {
    return null;
  }

  const team = await getCurrentTeam();

  if (!team) {
    return <NoTeamState />;
  }

  const currentStatus = (statusParam === 'completed' || statusParam === 'archived')
    ? statusParam as PlanStatus
    : undefined;

  const [plansResult, userRole, teamMembers] = await Promise.all([
    getPlansList(team.id, currentStatus),
    getUserRoleInTeam(team.id),
    getTeamMembers(team.id),
  ]);

  const { plans } = plansResult;
  const canCreate = userRole === 'owner' || userRole === 'admin';
  const activeTab = statusParam || 'all';

  return (
    <div className="animate-grow-in space-y-4 p-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Shared Plans</h1>
          <p className="text-sm text-text-calm">
            Coordinate team work with shared plans and tasks
          </p>
        </div>
        {canCreate && (
          <PlansPageClient teamId={team.id} teamMembers={teamMembers} />
        )}
      </header>

      <div className="flex gap-1 border-b border-border">
        {STATUS_TABS.map((tab) => (
          <Link
            key={tab.value}
            href={tab.value === 'all' ? '/plans' : `/plans?status=${tab.value}`}
            className={`px-3 py-2 text-xs font-medium transition-all border-b-2 -mb-px ${
              activeTab === tab.value
                ? 'border-leaf text-text-bright'
                : 'border-transparent text-text-quiet hover:text-text-calm'
            }`}
          >
            {tab.label}
          </Link>
        ))}
      </div>

      {plans.length === 0 ? (
        <EmptyState canCreate={canCreate} status={activeTab} />
      ) : (
        <div className="space-y-3">
          {plans.map((plan) => (
            <PlanCard key={plan.id} plan={plan} />
          ))}
        </div>
      )}
    </div>
  );
}

interface PlanCardProps {
  plan: any;
}

function PlanCard({ plan }: PlanCardProps) {
  const priorityColor = PRIORITY_COLORS[plan.priority] || PRIORITY_COLORS.normal;
  const statusColor = STATUS_COLORS[plan.status] || STATUS_COLORS.active;
  const stats = plan.task_stats || { total: 0, completed: 0, in_progress: 0 };
  const hasTaskStats = stats.total > 0;

  return (
    <Link
      href={`/plans/${plan.id}`}
      className="block rounded-lg border border-border bg-root p-4 transition-all hover:border-leaf/30 hover:bg-bark"
    >
      <div className="flex items-center justify-between gap-4">
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-medium text-text-bright line-clamp-1">
            {plan.title}
          </h3>

          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-text-quiet">
            <div className="flex items-center gap-1.5">
              {plan.profile?.avatar_url ? (
                <Image
                  src={plan.profile.avatar_url}
                  alt=""
                  width={20}
                  height={20}
                  className="rounded"
                />
              ) : (
                <div className="h-5 w-5 rounded bg-leaf/10 text-[9px] flex items-center justify-center text-leaf font-medium">
                  {getInitials(plan.profile?.full_name || plan.profile?.email)}
                </div>
              )}
              <span className="text-text-calm">{plan.profile?.full_name || 'Unknown'}</span>
            </div>

            <div className="flex items-center gap-1.5">
              <Clock className="h-3.5 w-3.5" />
              <span>{formatRelativeDate(plan.updated_at)}</span>
            </div>

            {hasTaskStats && (
              <>
                <div className="flex items-center gap-1.5">
                  <CheckCircle2 className="h-3.5 w-3.5 text-success" />
                  <span>{stats.completed}/{stats.total} tasks</span>
                </div>
                {stats.in_progress > 0 && (
                  <div className="flex items-center gap-1.5">
                    <Loader2 className="h-3.5 w-3.5 text-warning" />
                    <span>{stats.in_progress} in progress</span>
                  </div>
                )}
              </>
            )}
          </div>

        </div>

        <div className="flex shrink-0 items-center gap-2">
          <span className={`rounded px-2 py-0.5 text-[11px] font-medium capitalize ${priorityColor}`}>
            {plan.priority}
          </span>
          <span className={`rounded px-2 py-0.5 text-[11px] font-medium capitalize ${statusColor}`}>
            {plan.status}
          </span>
        </div>
      </div>
    </Link>
  );
}

interface EmptyStateProps {
  canCreate: boolean;
  status: string;
}

interface EmptyStateMessage {
  title: string;
  subtitle: string;
}

const EMPTY_STATE_MESSAGES: Readonly<Record<string, EmptyStateMessage>> = {
  all: {
    title: 'No active plans',
    subtitle: 'Create a plan to coordinate team work',
  },
  completed: {
    title: 'No completed plans',
    subtitle: 'Completed plans will appear here',
  },
  archived: {
    title: 'No archived plans',
    subtitle: 'Archived plans will appear here',
  },
};

function EmptyState({ canCreate, status }: EmptyStateProps) {
  const defaultMessage = EMPTY_STATE_MESSAGES.all;
  const message = EMPTY_STATE_MESSAGES[status] || defaultMessage;

  const subtitle = status === 'all' && !canCreate
    ? 'Ask an admin to create a plan'
    : message.subtitle;

  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border bg-root/50 py-8">
      <ClipboardList className="h-5 w-5 text-leaf mb-2" />
      <div className="text-center">
        <p className="text-xs font-medium text-text-bright">{message.title}</p>
        <p className="mt-1 text-[11px] text-text-calm">{subtitle}</p>
      </div>
    </div>
  );
}

function NoTeamState() {
  return (
    <div className="animate-grow-in space-y-4 p-6">
      <header>
        <h1 className="text-xl font-semibold">Shared Plans</h1>
        <p className="text-sm text-text-calm">
          Coordinate team work with shared plans and tasks
        </p>
      </header>

      <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border bg-root/50 py-8">
        <ClipboardList className="h-5 w-5 text-leaf mb-2" />
        <div className="text-center">
          <p className="text-xs font-medium text-text-bright">Create a team first</p>
          <p className="mt-1 text-[11px] text-text-calm">
            You need a team to view plans
          </p>
          <Link
            href="/team"
            className="mt-3 inline-flex items-center rounded-md bg-leaf px-3 py-1 text-[11px] font-medium text-soil hover:bg-bloom transition-all"
          >
            Create Team
          </Link>
        </div>
      </div>
    </div>
  );
}

