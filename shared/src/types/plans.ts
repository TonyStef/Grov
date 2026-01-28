/**
 * Shared Plans & Tasks types - team-wide AI coordination
 * Aligns with Supabase shared_plans and plan_tasks tables
 */

export type PlanTargetType = 'all' | 'specific';
export type PlanStatus = 'active' | 'archived' | 'completed';
export type PlanPriority = 'low' | 'normal' | 'high' | 'urgent';
export type TaskStatus = 'pending' | 'in_progress' | 'blocked' | 'completed' | 'skipped';

export interface SharedPlan {
  id: string;
  team_id: string;
  created_by: string;
  title: string;
  content: string;
  parsed_content: Record<string, unknown>;
  target_type: PlanTargetType;
  target_user_ids: string[];
  status: PlanStatus;
  priority: PlanPriority;
  created_at: string;
  updated_at: string;
}

export interface PlanTask {
  id: string;
  plan_id: string;
  title: string;
  description: string | null;
  order_index: number;
  status: TaskStatus;
  assigned_to: string | null;
  claimed_by: string | null;
  claimed_at: string | null;
  completed_by: string | null;
  completed_at: string | null;
  depends_on: string[];
  blocks: string[];
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface SharedPlanWithTasks extends SharedPlan {
  tasks: PlanTask[];
}

export interface SharedPlanWithProfile extends SharedPlan {
  profile?: {
    email: string;
    full_name: string | null;
    avatar_url: string | null;
  };
}

export interface CreatePlanInput {
  title: string;
  content: string;
  target_type?: PlanTargetType;
  target_user_ids?: string[];
  priority?: PlanPriority;
  tasks?: CreateTaskInput[];
}

export interface UpdatePlanInput {
  title?: string;
  content?: string;
  target_type?: PlanTargetType;
  target_user_ids?: string[];
  status?: PlanStatus;
  priority?: PlanPriority;
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  order_index?: number;
  assigned_to?: string;
  depends_on?: string[];
}

export interface UpdateTaskInput {
  title?: string;
  description?: string;
  order_index?: number;
  status?: TaskStatus;
  assigned_to?: string;
  notes?: string;
}

export interface PlanListResponse {
  plans: SharedPlanWithProfile[];
  cursor: string | null;
  has_more: boolean;
}

export interface PlanDetailResponse {
  plan: SharedPlanWithTasks;
}

export interface PlanInjectionContext {
  plan_id: string;
  title: string;
  content: string;
  priority: PlanPriority;
  tasks: PlanInjectionTask[];
}

export interface PlanInjectionTask {
  id: string;
  title: string;
  status: TaskStatus;
  claimed_by_name?: string;
  blocked_by?: string[];
}

