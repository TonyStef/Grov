import type { FastifyInstance, FastifyReply } from 'fastify';
import type {
  RecordInjectionRequest,
  RecordInjectionResponse,
  TeamUsageResponse,
  UsageHistoryResponse,
  UsageBreakdownResponse,
  UsageStatus,
} from '@grov/shared';
import { supabase } from '../db/client.js';
import { requireAuth, getAuthenticatedUser } from '../middleware/auth.js';
import { requireTeamMember, requireTeamAdmin } from '../middleware/team.js';

function sendError(reply: FastifyReply, status: number, error: string) {
  return reply.status(status).send({ error } as Record<string, unknown>);
}

const usageRateLimits = {
  record: { max: 100, timeWindow: '1 minute' },
  status: { max: 60, timeWindow: '1 minute' },
  history: { max: 30, timeWindow: '1 minute' },
  breakdown: { max: 30, timeWindow: '1 minute' },
};

function calculateStatus(percent: number): UsageStatus {
  if (percent >= 110) return 'overage';
  if (percent >= 100) return 'warning_100';
  if (percent >= 80) return 'warning_80';
  return 'normal';
}

export async function usagePublicRoutes(fastify: FastifyInstance) {
  fastify.post<{ Body: RecordInjectionRequest; Reply: RecordInjectionResponse }>(
    '/injection',
    { preHandler: [requireAuth], config: { rateLimit: usageRateLimits.record } },
    async (request, reply) => {
      const event = request.body;
      const authenticatedUser = getAuthenticatedUser(request);

      if (!event.team_id || !event.event_id || !event.injection_type) {
        return sendError(reply, 400, 'Missing required fields');
      }

      // Security: Validate authenticated user is a member of the specified team
      const { data: membership } = await supabase
        .from('team_members')
        .select('user_id')
        .eq('team_id', event.team_id)
        .eq('user_id', authenticatedUser.id)
        .single();

      if (!membership) {
        return sendError(reply, 403, 'Not a member of this team');
      }

      // Security: Use authenticated user ID instead of client-supplied value
      const { error: insertError } = await supabase.from('injection_events').insert({
        team_id: event.team_id,
        user_id: authenticatedUser.id,
        session_id: event.session_id,
        event_id: event.event_id,
        injection_type: event.injection_type,
        memory_ids: event.memory_ids || [],
        created_at: event.timestamp || new Date().toISOString(),
      });

      const isDuplicate = insertError?.code === '23505';
      if (insertError && !isDuplicate) {
        fastify.log.error(insertError);
        return sendError(reply, 500, 'Failed to record injection');
      }

      const now = new Date();
      const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
      const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);

      let currentCount = 0;

      if (!isDuplicate) {
        const { data: countResult, error: countError } = await supabase.rpc(
          'increment_injection_count',
          {
            p_team_id: event.team_id,
            p_period_start: periodStart.toISOString(),
            p_period_end: periodEnd.toISOString(),
          }
        );

        if (countError) {
          fastify.log.error(countError);
          return sendError(reply, 500, 'Failed to increment counter');
        }

        currentCount = countResult as number;
      } else {
        const { data: period } = await supabase
          .from('team_usage_periods')
          .select('injection_count')
          .eq('team_id', event.team_id)
          .eq('period_start', periodStart.toISOString())
          .single();

        currentCount = period?.injection_count ?? 0;
      }

      const { count: memberCount } = await supabase
        .from('team_members')
        .select('*', { count: 'exact', head: true })
        .eq('team_id', event.team_id);

      const { data: subscription } = await supabase
        .from('subscriptions')
        .select('plan:plans(injection_limit_per_seat)')
        .eq('team_id', event.team_id)
        .single();

      const plan = subscription?.plan as unknown as { injection_limit_per_seat: number } | null;
      const limitPerSeat = plan?.injection_limit_per_seat ?? 150;
      const quota = (memberCount || 1) * limitPerSeat;
      const percent = quota > 0 ? (currentCount / quota) * 100 : 0;

      return reply.status(202).send({
        success: true,
        current_count: currentCount,
        quota,
        status: calculateStatus(percent),
      });
    }
  );
}

export async function usageTeamRoutes(fastify: FastifyInstance) {
  fastify.get<{ Params: { id: string }; Reply: TeamUsageResponse }>(
    '/:id/usage',
    { preHandler: [requireAuth, requireTeamMember], config: { rateLimit: usageRateLimits.status } },
    async (request, reply) => {
      const { id: teamId } = request.params;

      const { data, error } = await supabase.rpc('get_team_usage_status', {
        p_team_id: teamId,
      });

      if (error) {
        fastify.log.error(error);
        return sendError(reply, 500, 'Failed to get usage status');
      }

      const row = (data as Array<{
        injection_count: number;
        quota: number;
        seat_count: number;
        limit_per_seat: number;
        overage_rate_cents: number;
        usage_percent: number;
        status: UsageStatus;
        period_start: string;
        period_end: string;
      }>)?.[0];

      if (!row) {
        const now = new Date();
        const { count: memberCount } = await supabase
          .from('team_members')
          .select('*', { count: 'exact', head: true })
          .eq('team_id', teamId);

        const { data: subscription } = await supabase
          .from('subscriptions')
          .select('plan:plans(injection_limit_per_seat, overage_rate_cents)')
          .eq('team_id', teamId)
          .single();

        const plan = subscription?.plan as unknown as { injection_limit_per_seat: number; overage_rate_cents: number } | null;
        const seats = memberCount || 1;
        const limitPerSeat = plan?.injection_limit_per_seat ?? 150;

        return {
          period: {
            start: new Date(now.getFullYear(), now.getMonth(), 1).toISOString(),
            end: new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString(),
          },
          injections: { used: 0, quota: seats * limitPerSeat, overage: 0, percent: 0 },
          seats: { count: seats, limit_per_seat: limitPerSeat },
          billing: { overage_rate_cents: plan?.overage_rate_cents ?? 2, estimated_overage_cost: 0 },
          status: 'normal' as UsageStatus,
        };
      }

      const overage = Math.max(0, row.injection_count - row.quota);

      return {
        period: { start: row.period_start, end: row.period_end },
        injections: {
          used: row.injection_count,
          quota: row.quota,
          overage,
          percent: row.usage_percent,
        },
        seats: { count: row.seat_count, limit_per_seat: row.limit_per_seat },
        billing: {
          overage_rate_cents: row.overage_rate_cents,
          estimated_overage_cost: overage * row.overage_rate_cents,
        },
        status: row.status,
      };
    }
  );

  fastify.get<{ Params: { id: string }; Querystring: { periods?: string }; Reply: UsageHistoryResponse }>(
    '/:id/usage/history',
    { preHandler: [requireAuth, requireTeamAdmin], config: { rateLimit: usageRateLimits.history } },
    async (request, reply) => {
      const { id: teamId } = request.params;
      const periodCount = Math.min(parseInt(request.query.periods || '6', 10), 24);

      const { data, error } = await supabase
        .from('team_usage_periods')
        .select('period_start, period_end, injection_count')
        .eq('team_id', teamId)
        .order('period_start', { ascending: false })
        .limit(periodCount);

      if (error) {
        fastify.log.error(error);
        return sendError(reply, 500, 'Failed to get usage history');
      }

      const { count: memberCount } = await supabase
        .from('team_members')
        .select('*', { count: 'exact', head: true })
        .eq('team_id', teamId);

      const { data: subscription } = await supabase
        .from('subscriptions')
        .select('plan:plans(injection_limit_per_seat, overage_rate_cents)')
        .eq('team_id', teamId)
        .single();

      const plan = subscription?.plan as unknown as { injection_limit_per_seat: number; overage_rate_cents: number } | null;
      const quota = (memberCount || 1) * (plan?.injection_limit_per_seat ?? 150);
      const rate = plan?.overage_rate_cents ?? 2;

      return {
        periods: (data || []).map((row) => {
          const overage = Math.max(0, row.injection_count - quota);
          return {
            start: row.period_start,
            end: row.period_end,
            injection_count: row.injection_count,
            quota,
            overage,
            overage_cost_cents: overage * rate,
          };
        }),
      };
    }
  );

  fastify.get<{ Params: { id: string }; Reply: UsageBreakdownResponse }>(
    '/:id/usage/breakdown',
    { preHandler: [requireAuth, requireTeamAdmin], config: { rateLimit: usageRateLimits.breakdown } },
    async (request, reply) => {
      const { id: teamId } = request.params;

      const now = new Date();
      const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
      const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);

      const { data: events, error } = await supabase
        .from('injection_events')
        .select('user_id, created_at, profiles!inner(email)')
        .eq('team_id', teamId)
        .gte('created_at', periodStart.toISOString())
        .lt('created_at', periodEnd.toISOString());

      if (error) {
        fastify.log.error(error);
        return sendError(reply, 500, 'Failed to get usage breakdown');
      }

      const userCounts = new Map<string, { email: string; count: number }>();
      const dayCounts = new Map<string, number>();
      let totalCount = 0;

      for (const row of events || []) {
        const userId = row.user_id;
        const email = (row.profiles as unknown as { email: string })?.email || 'unknown';
        const existing = userCounts.get(userId) || { email, count: 0 };
        existing.count++;
        userCounts.set(userId, existing);

        const date = row.created_at.split('T')[0];
        dayCounts.set(date, (dayCounts.get(date) || 0) + 1);

        totalCount++;
      }

      const byUser = Array.from(userCounts.entries())
        .map(([userId, data]) => ({
          user_id: userId,
          email: data.email,
          injection_count: data.count,
          percent_of_team: totalCount > 0 ? (data.count / totalCount) * 100 : 0,
        }))
        .sort((a, b) => b.injection_count - a.injection_count);

      const byDay = Array.from(dayCounts.entries())
        .map(([date, count]) => ({ date, injection_count: count }))
        .sort((a, b) => a.date.localeCompare(b.date));

      return {
        period: { start: periodStart.toISOString(), end: periodEnd.toISOString() },
        by_user: byUser,
        by_day: byDay,
      };
    }
  );
}
