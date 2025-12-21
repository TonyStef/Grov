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
    <div className="animate-grow-in space-y-4 p-6">
      <header>
        <h1 className="text-xl font-semibold">Memories</h1>
        <p className="text-sm text-text-calm">
          Browse captured reasoning from {team.name}&apos;s sessions
        </p>
      </header>

      <MemoriesFilters
        availableTags={availableTags}
        currentFilters={params}
      />

      {memories.length === 0 ? (
        <EmptyState hasFilters={!!(params.search || params.tags || params.status)} />
      ) : (
        <div className="space-y-3">
          {memories.map((memory) => (
            <MemoryCard key={memory.id} memory={memory} />
          ))}

          {has_more && cursor && (
            <div className="flex justify-center pt-4">
              <Link
                href={`/memories?${new URLSearchParams({
                  ...params,
                  cursor,
                }).toString()}`}
                className="rounded-lg bg-bark border border-border px-4 py-1.5 text-xs font-medium text-text-calm hover:bg-moss hover:border-leaf/30 transition-all"
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
      className="block rounded-lg border border-border bg-root p-4 transition-all hover:border-leaf/30 hover:bg-bark"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-medium text-text-bright line-clamp-1">
            {memory.goal || memory.original_query}
          </h3>

          {memory.goal && memory.original_query && (
            <p className="mt-1.5 text-xs text-text-calm line-clamp-1">
              {truncate(memory.original_query, 200)}
            </p>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-text-quiet">
            <div className="flex items-center gap-1.5">
              {memory.profile?.avatar_url ? (
                <img
                  src={memory.profile.avatar_url}
                  alt=""
                  className="h-5 w-5 rounded"
                />
              ) : (
                <div className="h-5 w-5 rounded bg-leaf/10 text-[9px] flex items-center justify-center text-leaf font-medium">
                  {getInitials(memory.profile?.full_name || memory.profile?.email)}
                </div>
              )}
              <span className="text-text-calm">{memory.profile?.full_name || 'Unknown'}</span>
            </div>

            <div className="flex items-center gap-1.5">
              <Clock className="h-3.5 w-3.5" />
              <span>{edited ? 'Edited' : 'Created'} {formatRelativeDate(lastDate)}</span>
            </div>

            {memory.files_touched && memory.files_touched.length > 0 && (
              <div className="flex items-center gap-1.5">
                <FileCode className="h-3.5 w-3.5" />
                <span>{memory.files_touched.length} files</span>
              </div>
            )}

            {memory.reasoning_trace && memory.reasoning_trace.length > 0 && (
              <div className="flex items-center gap-1.5">
                <Brain className="h-3.5 w-3.5" />
                <span>{memory.reasoning_trace.length} steps</span>
              </div>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {edited && (
            <span className="rounded bg-leaf/10 text-leaf px-2 py-0.5 text-[11px] font-medium">
              Edited
            </span>
          )}
          <span
            className={`rounded px-2 py-0.5 text-[11px] font-medium capitalize ${statusColor}`}
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
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border bg-root/50 py-8">
      <Brain className="h-5 w-5 text-leaf mb-2" />
      <div className="text-center">
        {hasFilters ? (
          <>
            <p className="text-xs font-medium text-text-bright">No memories found</p>
            <p className="mt-1 text-[11px] text-text-calm">
              Try adjusting your filters
            </p>
            <Link
              href="/memories"
              className="mt-3 inline-flex items-center rounded-md bg-bark border border-border px-3 py-1 text-[11px] font-medium text-text-calm hover:bg-moss transition-all"
            >
              Clear filters
            </Link>
          </>
        ) : (
          <>
            <p className="text-xs font-medium text-text-bright">No memories yet</p>
            <p className="mt-1 text-[11px] text-text-calm">
              Start syncing from the CLI
            </p>
          </>
        )}
      </div>
    </div>
  );
}

function NoTeamState() {
  return (
    <div className="animate-grow-in space-y-4 p-6">
      <header>
        <h1 className="text-xl font-semibold">Memories</h1>
        <p className="text-sm text-text-calm">
          Browse captured reasoning from your sessions
        </p>
      </header>

      <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border bg-root/50 py-8">
        <Brain className="h-5 w-5 text-leaf mb-2" />
        <div className="text-center">
          <p className="text-xs font-medium text-text-bright">Create a team first</p>
          <p className="mt-1 text-[11px] text-text-calm">
            You need a team to view memories
          </p>
          <Link
            href="/team"
            className="mt-3 inline-flex items-center rounded-md bg-leaf px-3 py-1 text-[11px] font-medium text-soil hover:bg-bloom transition-all"
          >
            Create Team
          </Link>
        </div>
      </div>
    </div>
  );
}
