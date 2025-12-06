import { createClient } from '@/lib/supabase/server';
import type { Memory } from '@grov/shared';

export interface MemoryWithProfile extends Memory {
  profile?: {
    email: string;
    full_name: string | null;
    avatar_url: string | null;
  };
}

export interface MemoryFilters {
  search?: string;
  tags?: string[];
  status?: string;
  user_id?: string;
  from?: string;
  to?: string;
}

export interface MemoriesListResult {
  memories: MemoryWithProfile[];
  cursor: string | null;
  has_more: boolean;
}

export interface DashboardStats {
  totalMemories: number;
  teamMembers: number;
  filesTouched: number;
  thisWeek: number;
}

/**
 * Get memories list with pagination and filters
 */
export async function getMemoriesList(
  teamId: string,
  filters: MemoryFilters = {},
  limit: number = 20,
  cursor?: string
): Promise<MemoriesListResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return { memories: [], cursor: null, has_more: false };
  }

  // Verify team membership
  const { data: membership } = await supabase
    .from('team_members')
    .select('team_id')
    .eq('team_id', teamId)
    .eq('user_id', user.id)
    .single();

  if (!membership) {
    return { memories: [], cursor: null, has_more: false };
  }

  // Build query
  let query = supabase
    .from('memories')
    .select(`
      *,
      profile:profiles!user_id (
        email,
        full_name,
        avatar_url
      )
    `)
    .eq('team_id', teamId)
    .order('created_at', { ascending: false })
    .limit(limit + 1); // Fetch one extra to check if there's more

  // Apply filters
  if (filters.search) {
    // Sanitize search input - remove special characters
    const sanitized = filters.search.replace(/[.,()]/g, '').trim();
    if (sanitized) {
      query = query.or(`original_query.ilike.%${sanitized}%,goal.ilike.%${sanitized}%`);
    }
  }

  if (filters.tags && filters.tags.length > 0) {
    query = query.overlaps('tags', filters.tags);
  }

  if (filters.status) {
    query = query.eq('status', filters.status);
  }

  if (filters.user_id) {
    query = query.eq('user_id', filters.user_id);
  }

  if (filters.from) {
    query = query.gte('created_at', filters.from);
  }

  if (filters.to) {
    query = query.lte('created_at', filters.to);
  }

  if (cursor) {
    query = query.lt('created_at', cursor);
  }

  const { data, error } = await query;

  if (error || !data) {
    return { memories: [], cursor: null, has_more: false };
  }

  const memories = data as MemoryWithProfile[];
  const has_more = memories.length > limit;

  if (has_more) {
    memories.pop(); // Remove the extra item
  }

  return {
    memories,
    cursor: has_more && memories.length > 0
      ? memories[memories.length - 1].created_at
      : null,
    has_more,
  };
}

/**
 * Get recent memories for dashboard
 */
export async function getRecentMemories(
  teamId: string,
  limit: number = 5
): Promise<MemoryWithProfile[]> {
  const result = await getMemoriesList(teamId, {}, limit);
  return result.memories;
}

/**
 * Get dashboard statistics for a team
 */
export async function getDashboardStats(teamId: string): Promise<DashboardStats> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return { totalMemories: 0, teamMembers: 0, filesTouched: 0, thisWeek: 0 };
  }

  // Verify team membership
  const { data: membership } = await supabase
    .from('team_members')
    .select('team_id')
    .eq('team_id', teamId)
    .eq('user_id', user.id)
    .single();

  if (!membership) {
    return { totalMemories: 0, teamMembers: 0, filesTouched: 0, thisWeek: 0 };
  }

  // Parallel queries for better performance
  const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const [memoriesResult, membersResult, weekMemoriesResult, filesResult] = await Promise.all([
    // Total memories count
    supabase
      .from('memories')
      .select('*', { count: 'exact', head: true })
      .eq('team_id', teamId),

    // Team members count
    supabase
      .from('team_members')
      .select('*', { count: 'exact', head: true })
      .eq('team_id', teamId),

    // This week's memories
    supabase
      .from('memories')
      .select('*', { count: 'exact', head: true })
      .eq('team_id', teamId)
      .gte('created_at', oneWeekAgo),

    // Get unique files touched
    supabase
      .from('memories')
      .select('files_touched')
      .eq('team_id', teamId),
  ]);

  // Calculate unique files
  const allFiles = new Set<string>();
  filesResult.data?.forEach((m: any) => {
    if (m.files_touched && Array.isArray(m.files_touched)) {
      m.files_touched.forEach((f: string) => allFiles.add(f));
    }
  });

  return {
    totalMemories: memoriesResult.count || 0,
    teamMembers: membersResult.count || 0,
    filesTouched: allFiles.size,
    thisWeek: weekMemoriesResult.count || 0,
  };
}

/**
 * Get a single memory by ID
 */
export async function getMemory(memoryId: string): Promise<MemoryWithProfile | null> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) return null;

  const { data: memory, error } = await supabase
    .from('memories')
    .select(`
      *,
      profile:profiles!user_id (
        email,
        full_name,
        avatar_url
      )
    `)
    .eq('id', memoryId)
    .single();

  if (error || !memory) return null;

  // Verify user is a member of the memory's team
  const { data: membership } = await supabase
    .from('team_members')
    .select('team_id')
    .eq('team_id', memory.team_id)
    .eq('user_id', user.id)
    .single();

  if (!membership) return null;

  return memory as MemoryWithProfile;
}

/**
 * Get unique tags used in a team's memories
 */
export async function getTeamTags(teamId: string): Promise<string[]> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) return [];

  // Verify membership
  const { data: membership } = await supabase
    .from('team_members')
    .select('team_id')
    .eq('team_id', teamId)
    .eq('user_id', user.id)
    .single();

  if (!membership) return [];

  const { data } = await supabase
    .from('memories')
    .select('tags')
    .eq('team_id', teamId);

  const allTags = new Set<string>();
  data?.forEach((m: any) => {
    if (m.tags && Array.isArray(m.tags)) {
      m.tags.forEach((t: string) => allTags.add(t));
    }
  });

  return Array.from(allTags).sort();
}
