import type { Metadata } from 'next';
import Link from 'next/link';
import { Brain, FileCode, Clock } from 'lucide-react';
import { createClient } from '@/lib/supabase/server';
import { getUserTeams } from '@/lib/queries/teams';
import { getMemoriesList, getTeamTags } from '@/lib/queries/memories';
import { formatRelativeDate, truncate, getInitials, getFileExtension } from '@/lib/utils';
import { MemoriesFilters } from './_components/memories-filters';

export const metadata: Metadata = {
  title: 'Memories',
};

interface PageProps {
  searchParams: Promise<{
    search?: string;
    tags?: string;
    status?: string;
    user?: string;
  }>;
}

export default async function MemoriesPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const supabase = await createClient();
  const { data: { user: authUser } } = await supabase.auth.getUser();

  if (!authUser) {
    return null;
  }

  const teams = await getUserTeams();

  if (teams.length === 0) {
    return <NoTeamState />;
  }

  const team = teams[0];

  // Parse filters from URL
  const filters = {
    search: params.search,
    tags: params.tags?.split(',').filter(Boolean),
    status: params.status,
    user_id: params.user,
  };

  // Fetch memories and available tags in parallel
  const [memoriesResult, availableTags] = await Promise.all([
    getMemoriesList(team.id, filters, 20),
    getTeamTags(team.id),
  ]);

  const { memories, has_more, cursor } = memoriesResult;

  return (
    <div className="animate-fade-in space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Memories</h1>
          <p className="mt-1 text-text-secondary">
            Browse captured reasoning from {team.name}&apos;s sessions
          </p>
        </div>
      </div>

      {/* Filters */}
      <MemoriesFilters
        availableTags={availableTags}
        currentFilters={params}
      />

      {/* Memories List */}
      {memories.length === 0 ? (
        <EmptyState hasFilters={!!(params.search || params.tags || params.status)} />
      ) : (
        <div className="space-y-4">
          {memories.map((memory) => (
            <MemoryCard key={memory.id} memory={memory} />
          ))}

          {/* Load more */}
          {has_more && cursor && (
            <div className="flex justify-center pt-4">
              <Link
                href={`/memories?${new URLSearchParams({
                  ...params,
                  cursor,
                }).toString()}`}
                className="rounded-md bg-bg-2 px-4 py-2 text-sm font-medium text-text-secondary hover:bg-bg-3 transition-colors"
              >
                Load more
              </Link>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Check if memory was edited (has at least 1 evolution step)
function wasMemoryEdited(memory: any): { edited: boolean; lastDate: string } {
  const evolutionSteps = memory.evolution_steps || [];
  if (evolutionSteps.length > 0) {
    const lastStep = evolutionSteps[evolutionSteps.length - 1];
    return { edited: true, lastDate: lastStep.date };
  }
  return { edited: false, lastDate: memory.created_at };
}

function MemoryCard({ memory }: { memory: any }) {
  const statusColors = {
    complete: 'bg-success/10 text-success',
    question: 'bg-warning/10 text-warning',
    partial: 'bg-info/10 text-info',
    abandoned: 'bg-error/10 text-error',
  };

  const statusColor = statusColors[memory.status as keyof typeof statusColors] || statusColors.complete;
  const { edited, lastDate } = wasMemoryEdited(memory);

  return (
    <Link
      href={`/memories/${memory.id}`}
      className="block rounded-lg border border-border bg-bg-1 p-6 transition-colors hover:border-border-hover hover:bg-bg-1/80"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          {/* Goal (title) - fallback to query if no goal */}
          <h3 className="text-lg font-medium text-text-primary line-clamp-2">
            {memory.goal || memory.original_query}
          </h3>

          {/* Original query (subtitle) - truncated, only show if goal exists */}
          {memory.goal && memory.original_query && (
            <p className="mt-1 text-sm text-text-secondary line-clamp-1">
              {truncate(memory.original_query, 200)}
            </p>
          )}

          {/* Meta */}
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-text-muted">
            {/* User */}
            <div className="flex items-center gap-2">
              {memory.profile?.avatar_url ? (
                <img
                  src={memory.profile.avatar_url}
                  alt=""
                  className="h-5 w-5 rounded-full"
                />
              ) : (
                <div className="h-5 w-5 rounded-full bg-accent-400/20 text-[10px] flex items-center justify-center text-accent-400">
                  {getInitials(memory.profile?.full_name || memory.profile?.email)}
                </div>
              )}
              <span>{memory.profile?.full_name || 'Unknown'}</span>
            </div>

            {/* Date - shows last activity (created or edited) */}
            <div className="flex items-center gap-1.5">
              <Clock className="h-4 w-4" />
              <span>{edited ? 'Edited' : 'Created'} {formatRelativeDate(lastDate)}</span>
            </div>

            {/* Files count */}
            {memory.files_touched && memory.files_touched.length > 0 && (
              <div className="flex items-center gap-1.5">
                <FileCode className="h-4 w-4" />
                <span>{memory.files_touched.length} files</span>
              </div>
            )}

            {/* Reasoning steps */}
            {memory.reasoning_trace && memory.reasoning_trace.length > 0 && (
              <div className="flex items-center gap-1.5">
                <Brain className="h-4 w-4" />
                <span>{memory.reasoning_trace.length} steps</span>
              </div>
            )}
          </div>

          {/* Tags */}
          {memory.tags && memory.tags.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {memory.tags.slice(0, 5).map((tag: string) => (
                <span
                  key={tag}
                  className="rounded-full bg-bg-2 px-2.5 py-0.5 text-xs text-text-secondary"
                >
                  {tag}
                </span>
              ))}
              {memory.tags.length > 5 && (
                <span className="text-xs text-text-muted">
                  +{memory.tags.length - 5} more
                </span>
              )}
            </div>
          )}
        </div>

        {/* Status badges */}
        <div className="flex shrink-0 items-center gap-2">
          {edited && (
            <span className="rounded-full bg-accent-400/10 text-accent-400 px-2.5 py-1 text-xs font-medium">
              Edited
            </span>
          )}
          <span
            className={`rounded-full px-2.5 py-1 text-xs font-medium capitalize ${statusColor}`}
          >
            {memory.status}
          </span>
        </div>
      </div>
    </Link>
  );
}

function EmptyState({ hasFilters }: { hasFilters: boolean }) {
  return (
    <div className="flex h-64 flex-col items-center justify-center rounded-lg border border-dashed border-border">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-bg-2">
        <Brain className="h-6 w-6 text-text-muted" />
      </div>
      <div className="mt-4 text-center">
        {hasFilters ? (
          <>
            <p className="text-lg font-medium">No memories found</p>
            <p className="mt-1 text-sm text-text-muted">
              Try adjusting your filters or search query
            </p>
            <Link
              href="/memories"
              className="mt-4 inline-flex items-center rounded-md bg-bg-2 px-4 py-2 text-sm font-medium text-text-secondary hover:bg-bg-3 transition-colors"
            >
              Clear filters
            </Link>
          </>
        ) : (
          <>
            <p className="text-lg font-medium">No memories yet</p>
            <p className="mt-1 text-sm text-text-muted">
              Memories will appear here once you start syncing from the CLI
            </p>
          </>
        )}
      </div>
    </div>
  );
}

function NoTeamState() {
  return (
    <div className="animate-fade-in space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Memories</h1>
        <p className="mt-1 text-text-secondary">
          Browse captured reasoning from your sessions
        </p>
      </div>

      <div className="flex h-64 flex-col items-center justify-center rounded-lg border border-dashed border-border">
        <div className="text-center">
          <p className="text-lg font-medium">Create a team first</p>
          <p className="mt-1 text-sm text-text-muted">
            You need to create a team before you can view memories
          </p>
          <Link
            href="/team"
            className="mt-4 inline-flex items-center rounded-md bg-accent-400 px-4 py-2 text-sm font-medium text-bg-0 hover:bg-accent-500 transition-colors"
          >
            Create Team
          </Link>
        </div>
      </div>
    </div>
  );
}
