import { createClient } from '@/lib/supabase/server';
import { getAuthUser, verifyTeamMembership } from '@/lib/auth';
import type { SharedPlan, PlanTask, PlanStatus, PlanPriority } from '@grov/shared';

export interface PlanWithProfile extends SharedPlan {
  profile?: {
    email: string;
    full_name: string | null;
    avatar_url: string | null;
  };
  task_stats?: {
    total: number;
    completed: number;
    in_progress: number;
  };
}

export interface PlanWithTasks extends SharedPlan {
  tasks: PlanTask[];
  profile?: {
    email: string;
    full_name: string | null;
    avatar_url: string | null;
  };
}

export interface PlansListResult {
  plans: PlanWithProfile[];
  cursor: string | null;
  has_more: boolean;
}

const DEFAULT_PLAN_LIMIT = 20;

interface TaskStats {
  total: number;
  completed: number;
  in_progress: number;
}

function createEmptyResult(): PlansListResult {
  return { plans: [], cursor: null, has_more: false };
}

function calculateTaskStats(tasks: Array<{ plan_id: string; status: string }>): Map<string, TaskStats> {
  const statsMap = new Map<string, TaskStats>();

  for (const task of tasks) {
    const stats = statsMap.get(task.plan_id) || { total: 0, completed: 0, in_progress: 0 };
    stats.total++;
    if (task.status === 'completed') stats.completed++;
    if (task.status === 'in_progress') stats.in_progress++;
    statsMap.set(task.plan_id, stats);
  }

  return statsMap;
}

export async function getPlansList(
  teamId: string,
  status?: PlanStatus,
  limit: number = DEFAULT_PLAN_LIMIT
): Promise<PlansListResult> {
  const user = await getAuthUser();
  if (!user) {
    return createEmptyResult();
  }

  const isMember = await verifyTeamMembership(user.id, teamId);
  if (!isMember) {
    return createEmptyResult();
  }

  const supabase = await createClient();

  let query = supabase
    .from('shared_plans')
    .select('*')
    .eq('team_id', teamId)
    .order('priority', { ascending: false })
    .order('updated_at', { ascending: false })
    .limit(limit + 1);

  query = status ? query.eq('status', status) : query.eq('status', 'active');

  const { data, error } = await query;

  if (error || !data) {
    return createEmptyResult();
  }

  const plans = data as PlanWithProfile[];
  const has_more = plans.length > limit;

  if (has_more) {
    plans.pop();
  }

  if (plans.length === 0) {
    return { plans, cursor: null, has_more: false };
  }

  const planIds = plans.map(p => p.id);
  const creatorIds = [...new Set(plans.map(p => p.created_by))];

  const [tasksResult, profilesResult] = await Promise.all([
    supabase.from('plan_tasks').select('plan_id, status').in('plan_id', planIds),
    supabase.from('profiles').select('id, email, full_name, avatar_url').in('id', creatorIds),
  ]);

  if (tasksResult.data) {
    const statsMap = calculateTaskStats(tasksResult.data);
    for (const plan of plans) {
      plan.task_stats = statsMap.get(plan.id) || { total: 0, completed: 0, in_progress: 0 };
    }
  }

  if (profilesResult.data) {
    const profileMap = new Map(profilesResult.data.map(p => [p.id, p]));
    for (const plan of plans) {
      const profile = profileMap.get(plan.created_by);
      if (profile) {
        plan.profile = {
          email: profile.email,
          full_name: profile.full_name,
          avatar_url: profile.avatar_url,
        };
      }
    }
  }

  return {
    plans,
    cursor: has_more && plans.length > 0 ? plans[plans.length - 1].updated_at : null,
    has_more,
  };
}

export async function getPlan(planId: string): Promise<PlanWithTasks | null> {
  const user = await getAuthUser();
  if (!user) return null;

  const supabase = await createClient();

  const { data: plan, error } = await supabase
    .from('shared_plans')
    .select('*')
    .eq('id', planId)
    .single();

  if (error || !plan) return null;

  const isMember = await verifyTeamMembership(user.id, plan.team_id);
  if (!isMember) return null;

  const [tasksResult, profileResult] = await Promise.all([
    supabase.from('plan_tasks').select('*').eq('plan_id', planId).order('order_index', { ascending: true }),
    supabase.from('profiles').select('email, full_name, avatar_url').eq('id', plan.created_by).single(),
  ]);

  return {
    ...plan,
    tasks: tasksResult.data || [],
    profile: profileResult.data || undefined,
  } as PlanWithTasks;
}

