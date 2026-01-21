import type { Metadata } from 'next';
import Link from 'next/link';
import Image from 'next/image';
import { Brain, FileCode, Clock, GitBranch } from 'lucide-react';
import { createClient } from '@/lib/supabase/server';
import { getCurrentTeam } from '@/lib/queries/current-team';
import { getMemoriesList, getTeamTags } from '@/lib/queries/memories';
import { getTeamBranches } from '@/lib/queries/branches';
import { getTeamMembers, getUserRoleInTeam } from '@/lib/queries/teams';
import { formatRelativeDate, truncate, getInitials } from '@/lib/utils';
import { MemoriesFilters } from './_components/memories-filters';
import { MemoriesPageClient } from './_components/memories-page-client';

export const metadata: Metadata = {
  title: 'Memories',
};

interface PageProps {
  searchParams: Promise<{
    search?: string;
    tags?: string;
    status?: string;
    user?: string;
    branch?: string;
  }>;
}

export default async function MemoriesPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const supabase = await createClient();
  const { data: { user: authUser } } = await supabase.auth.getUser();

  if (!authUser) {
    return null;
  }

  const team = await getCurrentTeam();

  if (!team) {
    return <NoTeamState />;
  }

  // Fetch team data first to get active branch
  const [teamMembers, branches, availableTags, userRole] = await Promise.all([
    getTeamMembers(team.id),
    getTeamBranches(team.id),
    getTeamTags(team.id),
    getUserRoleInTeam(team.id),
  ]);

  // Get user's active branch from team membership
  const currentMember = teamMembers.find(m => m.user_id === authUser.id);
  const savedActiveBranch = currentMember?.active_branch || 'main';
  const activeBranch = params.branch || savedActiveBranch;

  // Parse filters from URL
  const filters = {
    search: params.search,
    tags: params.tags?.split(',').filter(Boolean),
    status: params.status,
    user_id: params.user,
    branch: activeBranch,
  };

  // Fetch memories with branch filter
  const memoriesResult = await getMemoriesList(team.id, filters, 20);

  const { memories, has_more, cursor } = memoriesResult;

  return (
    <div className="animate-grow-in space-y-4 p-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Memories</h1>
          <p className="text-sm text-text-calm">
            Browse captured reasoning from {team.name}&apos;s sessions
          </p>
        </div>
        <MemoriesPageClient
          teamId={team.id}
          branches={branches}
          activeBranch={activeBranch}
          userRole={userRole}
          teamMembers={teamMembers.map(m => ({
            user_id: m.user_id,
            email: m.email,
            full_name: m.full_name,
            avatar_url: m.avatar_url,
          }))}
        />
      </header>

      <MemoriesFilters
        availableTags={availableTags}
        currentFilters={params}
        activeBranch={activeBranch}
      />

      {memories.length === 0 ? (
        <EmptyState hasFilters={!!(params.search || params.tags || params.status)} branchName={activeBranch} />
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

function getEditInfo(memory: { evolution_steps?: Array<{ date: string }>; created_at: string }): { edited: boolean; lastDate: string } {
  const steps = memory.evolution_steps || [];
  if (steps.length > 0) {
    return { edited: true, lastDate: steps[steps.length - 1].date };
  }
  return { edited: false, lastDate: memory.created_at };
}

const STATUS_COLORS: Record<string, string> = {
  complete: 'bg-success/10 text-success',
  question: 'bg-warning/10 text-warning',
  partial: 'bg-info/10 text-info',
  abandoned: 'bg-error/10 text-error',
};

function MemoryCard({ memory }: { memory: any }) {
  const statusColor = STATUS_COLORS[memory.status] || STATUS_COLORS.complete;
  const { edited, lastDate } = getEditInfo(memory);

  return (
    <Link
      href={`/memories/${memory.id}`}
      className="block rounded-lg border border-border bg-root p-4 transition-all hover:border-leaf/30 hover:bg-bark"
    >
      <div className="flex items-center justify-between gap-4">
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
                <Image
                  src={memory.profile.avatar_url}
                  alt=""
                  width={20}
                  height={20}
                  className="rounded"
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
          {/* Branch badge - show if not on main or if merged from another branch */}
          {memory.source_branch && (
            <span className="flex items-center gap-1 rounded bg-info/10 text-info px-2 py-0.5 text-[11px] font-medium">
              <GitBranch className="h-3 w-3" />
              {memory.source_branch}
            </span>
          )}
          {memory.branch && memory.branch !== 'main' && !memory.source_branch && (
            <span className="flex items-center gap-1 rounded bg-warning/10 text-warning px-2 py-0.5 text-[11px] font-medium">
              <GitBranch className="h-3 w-3" />
              {memory.branch}
            </span>
          )}
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

function EmptyState({ hasFilters, branchName }: { hasFilters: boolean; branchName: string }) {
  const isOnBranch = branchName !== 'main';

  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border bg-root/50 py-8">
      {isOnBranch ? (
        <GitBranch className="h-5 w-5 text-warning mb-2" />
      ) : (
        <Brain className="h-5 w-5 text-leaf mb-2" />
      )}
      <div className="text-center">
        {hasFilters ? (
          <>
            <p className="text-xs font-medium text-text-bright">No memories found</p>
            <p className="mt-1 text-[11px] text-text-calm">
              Try adjusting your filters
            </p>
            <Link
              href={isOnBranch ? `/memories?branch=${branchName}` : '/memories'}
              className="mt-3 inline-flex items-center rounded-md bg-bark border border-border px-3 py-1 text-[11px] font-medium text-text-calm hover:bg-moss transition-all"
            >
              Clear filters
            </Link>
          </>
        ) : isOnBranch ? (
          <>
            <p className="text-xs font-medium text-text-bright">
              No branch-specific memories yet
            </p>
            <p className="mt-1 text-[11px] text-text-calm max-w-xs">
              Main branch memories are still injected. New memories synced while on this branch will appear here.
            </p>
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
