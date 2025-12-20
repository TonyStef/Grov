import { createClient } from '@/lib/supabase/server';
import { getAuthUser, verifyTeamMembership } from '@/lib/auth';
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

interface MemoryFilesResult {
  files_touched: string[] | null;
}

interface MemoryTagsResult {
  tags: string[] | null;
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
  const user = await getAuthUser();

  if (!user) {
    return { memories: [], cursor: null, has_more: false };
  }

  const isMember = await verifyTeamMembership(user.id, teamId);
  if (!isMember) {
    return { memories: [], cursor: null, has_more: false };
  }

  const supabase = await createClient();

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
    .order('updated_at', { ascending: false })
    .limit(limit + 1);

  if (filters.search) {
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
    query = query.lt('updated_at', cursor);
  }

  const { data, error } = await query;

  if (error || !data) {
    return { memories: [], cursor: null, has_more: false };
  }

  const memories = data as MemoryWithProfile[];
  const has_more = memories.length > limit;

  if (has_more) {
    memories.pop();
  }

  return {
    memories,
    cursor: has_more && memories.length > 0
      ? memories[memories.length - 1].updated_at
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
  const user = await getAuthUser();

  if (!user) {
    return { totalMemories: 0, teamMembers: 0, filesTouched: 0, thisWeek: 0 };
  }

  const isMember = await verifyTeamMembership(user.id, teamId);
  if (!isMember) {
    return { totalMemories: 0, teamMembers: 0, filesTouched: 0, thisWeek: 0 };
  }

  const supabase = await createClient();
  const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const [memoriesResult, membersResult, weekMemoriesResult, filesResult] = await Promise.all([
    supabase
      .from('memories')
      .select('*', { count: 'exact', head: true })
      .eq('team_id', teamId),

    supabase
      .from('team_members')
      .select('*', { count: 'exact', head: true })
      .eq('team_id', teamId),

    supabase
      .from('memories')
      .select('*', { count: 'exact', head: true })
      .eq('team_id', teamId)
      .gte('created_at', oneWeekAgo),

    supabase
      .from('memories')
      .select('files_touched')
      .eq('team_id', teamId),
  ]);

  const allFiles = new Set<string>();
  (filesResult.data as MemoryFilesResult[] | null)?.forEach((m) => {
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
  const user = await getAuthUser();

  if (!user) return null;

  const supabase = await createClient();

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

  const isMember = await verifyTeamMembership(user.id, memory.team_id);
  if (!isMember) return null;

  return memory as MemoryWithProfile;
}

/**
 * Get unique tags used in a team's memories
 */
export async function getTeamTags(teamId: string): Promise<string[]> {
  const user = await getAuthUser();

  if (!user) return [];

  const isMember = await verifyTeamMembership(user.id, teamId);
  if (!isMember) return [];

  const supabase = await createClient();
  const { data } = await supabase
    .from('memories')
    .select('tags')
    .eq('team_id', teamId);

  const allTags = new Set<string>();
  (data as MemoryTagsResult[] | null)?.forEach((m) => {
    if (m.tags && Array.isArray(m.tags)) {
      m.tags.forEach((t: string) => allTags.add(t));
    }
  });

  return Array.from(allTags).sort();
}
