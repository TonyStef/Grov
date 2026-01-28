import type { Metadata } from 'next';
import Link from 'next/link';
import Image from 'next/image';
import { notFound } from 'next/navigation';
import { ArrowLeft, Clock, User } from 'lucide-react';
import { createClient } from '@/lib/supabase/server';
import { getPlan } from '@/lib/queries/plans';
import { getUserRoleInTeam, getTeamMembers } from '@/lib/queries/teams';
import { formatRelativeDate, getInitials } from '@/lib/utils';
import { TaskList } from './_components/task-list';
import { PlanActions } from './_components/plan-actions';

export const metadata: Metadata = {
  title: 'Plan Details',
};

interface PageProps {
  params: Promise<{ id: string }>;
}

const PRIORITY_COLORS: Record<string, string> = {
  urgent: 'bg-error/10 text-error',
  high: 'bg-warning/10 text-warning',
  normal: 'bg-info/10 text-info',
  low: 'bg-text-quiet/10 text-text-quiet',
};

const STATUS_COLORS: Record<string, string> = {
  active: 'bg-success/10 text-success',
  completed: 'bg-leaf/10 text-leaf',
  archived: 'bg-text-quiet/10 text-text-quiet',
};

export default async function PlanDetailPage({ params }: PageProps) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user: authUser } } = await supabase.auth.getUser();

  if (!authUser) {
    return null;
  }

  const plan = await getPlan(id);

  if (!plan) {
    notFound();
  }

  const [userRole, teamMembers] = await Promise.all([
    getUserRoleInTeam(plan.team_id),
    getTeamMembers(plan.team_id),
  ]);

  const canEdit = userRole === 'owner' || userRole === 'admin';
  const priorityColor = PRIORITY_COLORS[plan.priority] || PRIORITY_COLORS.normal;
  const statusColor = STATUS_COLORS[plan.status] || STATUS_COLORS.active;

  const completedTasks = plan.tasks.filter(t => t.status === 'completed').length;
  const progress = plan.tasks.length > 0 ? Math.round((completedTasks / plan.tasks.length) * 100) : 0;

  return (
    <div className="animate-grow-in space-y-6 p-6">
      <header className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <Link
            href="/plans"
            className="mt-1 rounded p-1 text-text-quiet hover:bg-bark hover:text-text-calm transition-all"
          >
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-semibold">{plan.title}</h1>
              <span className={`rounded px-2 py-0.5 text-[11px] font-medium capitalize ${priorityColor}`}>
                {plan.priority}
              </span>
              <span className={`rounded px-2 py-0.5 text-[11px] font-medium capitalize ${statusColor}`}>
                {plan.status}
              </span>
            </div>
            {plan.content && (
              <p className="mt-1 text-sm text-text-calm">{plan.content}</p>
            )}
            <div className="mt-2 flex items-center gap-4 text-xs text-text-quiet">
              <div className="flex items-center gap-1.5">
                {plan.profile?.avatar_url ? (
                  <Image
                    src={plan.profile.avatar_url}
                    alt=""
                    width={16}
                    height={16}
                    className="rounded"
                  />
                ) : (
                  <div className="h-4 w-4 rounded bg-leaf/10 text-[8px] flex items-center justify-center text-leaf font-medium">
                    {getInitials(plan.profile?.full_name || plan.profile?.email)}
                  </div>
                )}
                <span>{plan.profile?.full_name || 'Unknown'}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <Clock className="h-3.5 w-3.5" />
                <span>Updated {formatRelativeDate(plan.updated_at)}</span>
              </div>
            </div>
          </div>
        </div>
        {canEdit && (
          <PlanActions teamId={plan.team_id} planId={plan.id} status={plan.status} />
        )}
      </header>

      {plan.tasks.length > 0 && (
        <div className="flex items-center gap-3">
          <div className="flex-1 h-2 rounded-full bg-bark">
            <div
              className="h-full rounded-full bg-success transition-all"
              style={{ width: `${progress}%` }}
            />
          </div>
          <span className="text-xs text-text-calm">{completedTasks}/{plan.tasks.length} complete</span>
        </div>
      )}

      <TaskList
        teamId={plan.team_id}
        planId={plan.id}
        tasks={plan.tasks}
        currentUserId={authUser.id}
        teamMembers={teamMembers}
        canEdit={canEdit}
      />
    </div>
  );
}

