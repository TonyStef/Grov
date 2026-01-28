import type { FastifyInstance, FastifyReply } from 'fastify';
import type {
  CreatePlanInput,
  UpdatePlanInput,
  CreateTaskInput,
  UpdateTaskInput,
  PlanListResponse,
  PlanInjectionContext,
} from '@grov/shared';
import { supabase } from '../db/client.js';
import { requireAuth, getAuthenticatedUser } from '../middleware/auth.js';
import { requireTeamMember, requireTeamAdmin } from '../middleware/team.js';

const HTTP_NOT_FOUND = 404;
const HTTP_BAD_REQUEST = 400;
const HTTP_SERVER_ERROR = 500;
const HTTP_CREATED = 201;

const RATE_LIMITS = {
  list: { max: 60, timeWindow: '1 minute' },
  read: { max: 60, timeWindow: '1 minute' },
  create: { max: 10, timeWindow: '1 minute' },
  update: { max: 30, timeWindow: '1 minute' },
  delete: { max: 10, timeWindow: '1 minute' },
  injection: { max: 120, timeWindow: '1 minute' },
} as const;

function sendError(reply: FastifyReply, status: number, error: string) {
  return reply.status(status).send({ error } as Record<string, unknown>);
}

async function verifyPlanOwnership(teamId: string, planId: string): Promise<boolean> {
  const { data } = await supabase
    .from('shared_plans')
    .select('id')
    .eq('id', planId)
    .eq('team_id', teamId)
    .single();
  return !!data;
}

async function verifyTaskOwnership(teamId: string, planId: string, taskId: string): Promise<boolean> {
  const planOwned = await verifyPlanOwnership(teamId, planId);
  if (!planOwned) return false;
  const { data } = await supabase
    .from('plan_tasks')
    .select('id')
    .eq('id', taskId)
    .eq('plan_id', planId)
    .single();
  return !!data;
}

export default async function plansRoutes(fastify: FastifyInstance) {
  fastify.get<{ Params: { id: string }; Reply: PlanListResponse }>(
    '/:id/plans',
    { preHandler: [requireAuth, requireTeamMember], config: { rateLimit: RATE_LIMITS.list } },
    async (request, reply) => {
      const { id: teamId } = request.params;
      const user = getAuthenticatedUser(request);

      const { data, error } = await supabase
        .from('shared_plans')
        .select(`
          *,
          profile:profiles!created_by (
            email,
            full_name,
            avatar_url
          )
        `)
        .eq('team_id', teamId)
        .eq('status', 'active')
        .or(`target_type.eq.all,target_user_ids.cs.{${user.id}},created_by.eq.${user.id}`)
        .order('priority', { ascending: false })
        .order('created_at', { ascending: false });

      if (error) {
        fastify.log.error(error);
        return sendError(reply, HTTP_SERVER_ERROR, 'Failed to fetch plans');
      }

      return { plans: data || [], cursor: null, has_more: false };
    }
  );

  fastify.get<{ Params: { id: string; planId: string } }>(
    '/:id/plans/:planId',
    { preHandler: [requireAuth, requireTeamMember], config: { rateLimit: RATE_LIMITS.read } },
    async (request, reply) => {
      const { id: teamId, planId } = request.params;

      const { data: plan, error: planError } = await supabase
        .from('shared_plans')
        .select('*')
        .eq('id', planId)
        .eq('team_id', teamId)
        .single();

      if (planError || !plan) {
        return sendError(reply, HTTP_NOT_FOUND, 'Plan not found');
      }

      const { data: tasks, error: tasksError } = await supabase
        .from('plan_tasks')
        .select('*')
        .eq('plan_id', planId)
        .order('order_index', { ascending: true });

      if (tasksError) {
        fastify.log.error(tasksError);
        return sendError(reply, HTTP_SERVER_ERROR, 'Failed to fetch tasks');
      }

      return { plan: { ...plan, tasks: tasks || [] } };
    }
  );

  fastify.post<{ Params: { id: string }; Body: CreatePlanInput }>(
    '/:id/plans',
    { preHandler: [requireAuth, requireTeamAdmin], config: { rateLimit: RATE_LIMITS.create } },
    async (request, reply) => {
      const { id: teamId } = request.params;
      const user = getAuthenticatedUser(request);
      const { title, content, target_type, target_user_ids, priority, tasks } = request.body;

      const { data: plan, error: planError } = await supabase
        .from('shared_plans')
        .insert({
          team_id: teamId,
          created_by: user.id,
          title,
          content,
          target_type: target_type || 'all',
          target_user_ids: target_user_ids || [],
          priority: priority || 'normal',
        })
        .select()
        .single();

      if (planError) {
        fastify.log.error(planError);
        return sendError(reply, HTTP_SERVER_ERROR, 'Failed to create plan');
      }

      if (tasks?.length) {
        const taskInserts = tasks.map((t, i) => ({
          plan_id: plan.id,
          title: t.title,
          description: t.description || null,
          order_index: t.order_index ?? i,
          assigned_to: t.assigned_to || null,
          depends_on: t.depends_on || [],
        }));

        const { error: tasksError } = await supabase.from('plan_tasks').insert(taskInserts);
        if (tasksError) {
          fastify.log.error(tasksError);
        }
      }

      return reply.status(HTTP_CREATED).send(plan);
    }
  );

  fastify.patch<{ Params: { id: string; planId: string }; Body: UpdatePlanInput }>(
    '/:id/plans/:planId',
    { preHandler: [requireAuth, requireTeamAdmin], config: { rateLimit: RATE_LIMITS.update } },
    async (request, reply) => {
      const { id: teamId, planId } = request.params;
      const { title, content, target_type, target_user_ids, status, priority } = request.body;

      const updates: Record<string, unknown> = {};
      if (title !== undefined) updates.title = title;
      if (content !== undefined) updates.content = content;
      if (target_type !== undefined) updates.target_type = target_type;
      if (target_user_ids !== undefined) updates.target_user_ids = target_user_ids;
      if (status !== undefined) updates.status = status;
      if (priority !== undefined) updates.priority = priority;

      const { data, error } = await supabase
        .from('shared_plans')
        .update(updates)
        .eq('id', planId)
        .eq('team_id', teamId)
        .select()
        .single();

      if (error) {
        fastify.log.error(error);
        if (error.code === 'PGRST116') {
          return sendError(reply, HTTP_NOT_FOUND, 'Plan not found');
        }
        return sendError(reply, HTTP_SERVER_ERROR, 'Failed to update plan');
      }

      return data;
    }
  );

  // Delete plan
  fastify.delete<{ Params: { id: string; planId: string } }>(
    '/:id/plans/:planId',
    { preHandler: [requireAuth, requireTeamAdmin], config: { rateLimit: RATE_LIMITS.delete } },
    async (request, reply) => {
      const { id: teamId, planId } = request.params;

      const { error } = await supabase
        .from('shared_plans')
        .delete()
        .eq('id', planId)
        .eq('team_id', teamId);

      if (error) {
        fastify.log.error(error);
        return sendError(reply, 500, 'Failed to delete plan');
      }

      return { success: true };
    }
  );

  // Add task to plan
  fastify.post<{ Params: { id: string; planId: string }; Body: CreateTaskInput }>(
    '/:id/plans/:planId/tasks',
    { preHandler: [requireAuth, requireTeamMember], config: { rateLimit: RATE_LIMITS.update } },
    async (request, reply) => {
      const { id: teamId, planId } = request.params;
      const { title, description, order_index, assigned_to, depends_on } = request.body;

      if (!await verifyPlanOwnership(teamId, planId)) {
        return sendError(reply, HTTP_NOT_FOUND, 'Plan not found');
      }

      const { data, error } = await supabase
        .from('plan_tasks')
        .insert({
          plan_id: planId,
          title,
          description: description || null,
          order_index: order_index ?? 0,
          assigned_to: assigned_to || null,
          depends_on: depends_on || [],
        })
        .select()
        .single();

      if (error) {
        fastify.log.error(error);
        return sendError(reply, 500, 'Failed to create task');
      }

      return reply.status(201).send(data);
    }
  );

  // Update task
  fastify.patch<{ Params: { id: string; planId: string; taskId: string }; Body: UpdateTaskInput }>(
    '/:id/plans/:planId/tasks/:taskId',
    { preHandler: [requireAuth, requireTeamMember], config: { rateLimit: RATE_LIMITS.update } },
    async (request, reply) => {
      const { id: teamId, planId, taskId } = request.params;
      const { title, description, order_index, status, assigned_to, notes } = request.body;

      if (!await verifyTaskOwnership(teamId, planId, taskId)) {
        return sendError(reply, HTTP_NOT_FOUND, 'Task not found');
      }

      const updates: Record<string, unknown> = {};
      if (title !== undefined) updates.title = title;
      if (description !== undefined) updates.description = description;
      if (order_index !== undefined) updates.order_index = order_index;
      if (status !== undefined) updates.status = status;
      if (assigned_to !== undefined) updates.assigned_to = assigned_to;
      if (notes !== undefined) updates.notes = notes;

      const { data, error } = await supabase
        .from('plan_tasks')
        .update(updates)
        .eq('id', taskId)
        .select()
        .single();

      if (error) {
        fastify.log.error(error);
        return sendError(reply, 500, 'Failed to update task');
      }

      return data;
    }
  );

  // Claim task
  fastify.post<{ Params: { id: string; planId: string; taskId: string } }>(
    '/:id/plans/:planId/tasks/:taskId/claim',
    { preHandler: [requireAuth, requireTeamMember], config: { rateLimit: RATE_LIMITS.update } },
    async (request, reply) => {
      const { id: teamId, planId, taskId } = request.params;
      const user = getAuthenticatedUser(request);

      if (!await verifyTaskOwnership(teamId, planId, taskId)) {
        return sendError(reply, HTTP_NOT_FOUND, 'Task not found');
      }

      const { data, error } = await supabase
        .from('plan_tasks')
        .update({
          status: 'in_progress',
          claimed_by: user.id,
          claimed_at: new Date().toISOString(),
        })
        .eq('id', taskId)
        .eq('status', 'pending')
        .select()
        .single();

      if (error) {
        fastify.log.error(error);
        return sendError(reply, 400, 'Task already claimed or not found');
      }

      return data;
    }
  );

  // Complete task
  fastify.post<{ Params: { id: string; planId: string; taskId: string }; Body: { notes?: string } }>(
    '/:id/plans/:planId/tasks/:taskId/complete',
    { preHandler: [requireAuth, requireTeamMember], config: { rateLimit: RATE_LIMITS.update } },
    async (request, reply) => {
      const { id: teamId, planId, taskId } = request.params;
      const user = getAuthenticatedUser(request);
      const notes = request.body?.notes;

      if (!await verifyTaskOwnership(teamId, planId, taskId)) {
        return sendError(reply, HTTP_NOT_FOUND, 'Task not found');
      }

      const { data, error } = await supabase
        .from('plan_tasks')
        .update({
          status: 'completed',
          completed_by: user.id,
          completed_at: new Date().toISOString(),
          notes: notes || null,
        })
        .eq('id', taskId)
        .select()
        .single();

      if (error) {
        fastify.log.error(error);
        return sendError(reply, 500, 'Failed to complete task');
      }

      return data;
    }
  );

  // Get injection context for CLI
  fastify.get<{ Params: { id: string } }>(
    '/:id/plans/injection',
    { preHandler: [requireAuth, requireTeamMember], config: { rateLimit: RATE_LIMITS.injection } },
    async (request) => {
      const { id: teamId } = request.params;
      const user = getAuthenticatedUser(request);

      const { data: plans, error: plansError } = await supabase
        .from('shared_plans')
        .select('id, title, content, priority')
        .eq('team_id', teamId)
        .eq('status', 'active')
        .or(`target_type.eq.all,target_user_ids.cs.{${user.id}}`);

      if (plansError || !plans || plans.length === 0) {
        return { plans: [] };
      }

      const planIds = plans.map(p => p.id);
      const { data: tasks } = await supabase
        .from('plan_tasks')
        .select('id, plan_id, title, status, depends_on, claimer:profiles!claimed_by(full_name)')
        .in('plan_id', planIds)
        .order('order_index', { ascending: true });

      const allTasks = tasks || [];
      type TaskRow = typeof allTasks[number];
      const taskMap = new Map<string, TaskRow>(allTasks.map(t => [t.id, t]));

      const injection: PlanInjectionContext[] = plans.map(plan => ({
        plan_id: plan.id,
        title: plan.title,
        content: plan.content,
        priority: plan.priority,
        tasks: allTasks
          .filter(t => t.plan_id === plan.id)
          .map(t => {
            const blockers = ((t.depends_on || []) as string[])
              .map((depId: string) => taskMap.get(depId))
              .filter((dep): dep is TaskRow => !!dep && dep.status !== 'completed' && dep.status !== 'skipped')
              .map(dep => dep.title);

            return {
              id: t.id,
              title: t.title,
              status: t.status,
              claimed_by_name: (t.claimer as { full_name: string }[] | null)?.[0]?.full_name,
              blocked_by: blockers.length > 0 ? blockers : undefined,
            };
          }),
      }));

      return { plans: injection };
    }
  );
}
