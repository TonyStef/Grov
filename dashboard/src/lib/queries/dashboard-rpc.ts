import { createClient } from '@/lib/supabase/server';

/**
 * Dashboard data returned by get_dashboard_data_v2 RPC
 * Single query replaces 12+ individual queries
 */
export interface DashboardRpcResponse {
  user: {
    id: string;
    email: string;
    full_name: string | null;
    avatar_url: string | null;
    created_at: string;
  } | null;
  teams: Array<{
    id: string;
    name: string;
    slug: string;
    created_at: string;
    member_count: number;
    last_memory_at: string | null;
    joined_at: string;
  }>;
  current_team: {
    id: string;
    name: string;
    slug: string;
  } | null;
  stats: {
    total_memories: number;
    this_week: number;
    team_members: number;
    files_touched: number;
  };
  recent_memories: Array<{
    id: string;
    original_query: string;
    goal: string | null;
    status: string;
    created_at: string;
    files_touched: string[] | null;
    tags: string[] | null;
    profile: {
      email: string;
      full_name: string | null;
      avatar_url: string | null;
    } | null;
  }>;
  error?: string;
  code?: string;
}

/**
 * Fetch all dashboard data in a single RPC call
 * Reduces ~12 sequential queries to 1
 */
export async function getDashboardData(): Promise<DashboardRpcResponse | null> {
  const supabase = await createClient();

  const { data, error } = await supabase.rpc('get_dashboard_data_v2');

  if (error) {
    console.error('Dashboard RPC error:', error);
    return null;
  }

  // Handle auth error from RPC
  if (data?.error) {
    console.error('Dashboard RPC returned error:', data.error);
    return null;
  }

  return data as DashboardRpcResponse;
}
