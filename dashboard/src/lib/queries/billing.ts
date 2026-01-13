import { cache } from 'react';
import { createClient } from '@/lib/supabase/server';
import { getAuthUser, getAuthSession } from '@/lib/auth';
import type {
  PlansResponse,
  SubscriptionResponse,
  PlanWithPrices,
} from '@grov/shared';

const API_URL = process.env.API_URL || 'http://localhost:3001';

export const getPlans = cache(async (): Promise<PlanWithPrices[]> => {
  const response = await fetch(`${API_URL}/billing/plans`, {
    next: { revalidate: 3600 },
  });

  if (!response.ok) {
    return [];
  }

  const data: PlansResponse = await response.json();
  return data.plans;
});

export const getSubscription = cache(async (
  teamId: string
): Promise<SubscriptionResponse | null> => {
  const auth = await getAuthSession();
  if (!auth) return null;

  const response = await fetch(`${API_URL}/teams/${teamId}/billing/subscription`, {
    headers: {
      Authorization: `Bearer ${auth.accessToken}`,
    },
    next: { revalidate: 60 },
  });

  if (!response.ok) {
    return null;
  }

  return response.json();
});

export const isTeamOwner = cache(async (teamId: string): Promise<boolean> => {
  const user = await getAuthUser();
  if (!user) return false;

  const supabase = await createClient();
  const { data: membership } = await supabase
    .from('team_members')
    .select('role')
    .eq('team_id', teamId)
    .eq('user_id', user.id)
    .single();

  return membership?.role === 'owner';
});
