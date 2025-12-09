import type { Metadata } from 'next';
import Link from 'next/link';
import { Brain, ChevronRight } from 'lucide-react';
import { getUserTeams } from '@/lib/queries/teams';
import { getDashboardStats, getRecentMemories } from '@/lib/queries/memories';
import { getCurrentUser } from '@/lib/queries/profiles';
import { formatRelativeDate, truncate, getInitials } from '@/lib/utils';

export const metadata: Metadata = {
  title: 'Dashboard',
};

export default async function DashboardPage() {
  const [currentUser, teams] = await Promise.all([
    getCurrentUser(),
    getUserTeams(),
  ]);

  // No team - show welcome screen
  if (teams.length === 0) {
    return <NoTeamDashboard userName={currentUser?.full_name} />;
  }

  // Get stats and recent memories for first team
  const team = teams[0];
  const [stats, recentMemories] = await Promise.all([
    getDashboardStats(team.id),
    getRecentMemories(team.id, 5),
  ]);

  return (
    <div className="animate-fade-in space-y-6">
      {/* Welcome */}
      <div>
        <h1 className="text-2xl font-semibold">
          Welcome back{currentUser?.full_name ? `, ${currentUser.full_name.split(' ')[0]}` : ''}
        </h1>
        <p className="mt-1 text-text-secondary">
          {team.name}&apos;s collective AI memory
        </p>
      </div>

      {/* Stats Grid */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          title="Total Memories"
          value={stats.totalMemories.toString()}
          description="Captured reasoning"
        />
        <StatCard
          title="Team Members"
          value={stats.teamMembers.toString()}
          description="Active contributors"
        />
        <StatCard
          title="Files Touched"
          value={stats.filesTouched.toString()}
          description="Across all sessions"
        />
        <StatCard
          title="This Week"
          value={stats.thisWeek.toString()}
          description="New memories"
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Recent Activity */}
        <div className="rounded-lg border border-border bg-bg-1 p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-medium">Recent Activity</h2>
            {recentMemories.length > 0 && (
              <Link
                href="/memories"
                className="flex items-center gap-1 text-sm text-accent-400 hover:text-accent-500 transition-colors"
              >
                View all
                <ChevronRight className="h-4 w-4" />
              </Link>
            )}
          </div>

          {recentMemories.length === 0 ? (
            <div className="flex h-32 items-center justify-center text-text-muted">
              <div className="text-center">
                <Brain className="h-8 w-8 mx-auto mb-2 opacity-50" />
                <p>No memories yet</p>
                <p className="text-sm mt-1">Start a Claude Code session to capture reasoning</p>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              {recentMemories.map((memory) => (
                <Link
                  key={memory.id}
                  href={`/memories/${memory.id}`}
                  className="block rounded-md bg-bg-2 p-3 transition-colors hover:bg-bg-3"
                >
                  <p className="text-sm font-medium line-clamp-1">
                    {truncate(memory.original_query, 60)}
                  </p>
                  <div className="mt-1 flex items-center gap-2 text-xs text-text-muted">
                    {memory.profile?.avatar_url ? (
                      <img
                        src={memory.profile.avatar_url}
                        alt=""
                        className="h-4 w-4 rounded-full"
                      />
                    ) : (
                      <div className="h-4 w-4 rounded-full bg-accent-400/20 text-[8px] flex items-center justify-center text-accent-400">
                        {getInitials(memory.profile?.full_name || memory.profile?.email)}
                      </div>
                    )}
                    <span>{memory.profile?.full_name || 'Unknown'}</span>
                    <span>•</span>
                    <span>{formatRelativeDate(memory.created_at)}</span>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>

        {/* Getting Started */}
        <div className="rounded-lg border border-border bg-bg-1 p-6">
          <h2 className="mb-4 text-lg font-medium">Getting Started</h2>
          <div className="space-y-4">
            <Step
              number={1}
              title="Install the CLI"
              description="Run this command in your terminal"
              code="npm install -g grov"
            />
            <Step
              number={2}
              title="Login to your account"
              description="Connect your CLI to your team"
              code="grov login"
            />
            <Step
              number={3}
              title="Enable sync"
              description="Start capturing reasoning from your sessions"
              code={`grov sync --enable --team ${team.id.slice(0, 8)}...`}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function StatCard({
  title,
  value,
  description,
}: {
  title: string;
  value: string;
  description: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-bg-1 p-4 hover-lift">
      <p className="text-sm text-text-secondary">{title}</p>
      <p className="mt-1 text-3xl font-semibold">{value}</p>
      <p className="mt-1 text-xs text-text-muted">{description}</p>
    </div>
  );
}

function Step({
  number,
  title,
  description,
  code,
}: {
  number: number;
  title: string;
  description: string;
  code: string;
}) {
  return (
    <div className="flex gap-4">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent-400/20 font-mono text-sm font-medium text-accent-400">
        {number}
      </div>
      <div className="flex-1">
        <p className="font-medium">{title}</p>
        <p className="text-sm text-text-secondary">{description}</p>
        <code className="mt-2 block rounded bg-bg-2 px-3 py-2 font-mono text-sm text-accent-400">
          {code}
        </code>
      </div>
    </div>
  );
}

function NoTeamDashboard({ userName }: { userName?: string | null }) {
  return (
    <div className="animate-fade-in space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">
          Welcome{userName ? `, ${userName.split(' ')[0]}` : ' to Grov'}
        </h1>
        <p className="mt-1 text-text-secondary">
          Let&apos;s get you set up with your team
        </p>
      </div>

      <div className="flex flex-col items-center justify-center py-12">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-accent-400/10">
          <span className="font-mono text-2xl font-bold text-accent-400">g</span>
        </div>
        <h2 className="mt-6 text-xl font-semibold text-text-primary">
          Create Your First Team
        </h2>
        <p className="mt-2 text-center text-text-secondary max-w-md">
          Teams let you share AI reasoning with your collaborators. Create a team
          to start capturing memories from your Claude Code sessions.
        </p>
        <Link
          href="/team"
          className="mt-6 inline-flex items-center rounded-md bg-accent-400 px-6 py-3 text-sm font-medium text-bg-0 transition-colors hover:bg-accent-500"
        >
          Create Team
        </Link>
      </div>

      {/* Getting Started Preview */}
      <div className="rounded-lg border border-border bg-bg-1 p-6 opacity-60">
        <h2 className="mb-4 text-lg font-medium">Next Steps (after team creation)</h2>
        <div className="space-y-4">
          <Step
            number={1}
            title="Install the CLI"
            description="Run this command in your terminal"
            code="npm install -g grov"
          />
          <Step
            number={2}
            title="Login to your account"
            description="Connect your CLI to your team"
            code="grov login"
          />
          <Step
            number={3}
            title="Enable sync"
            description="Start capturing reasoning from your sessions"
            code="grov sync --enable --team <team-id>"
          />
        </div>
      </div>
    </div>
  );
}
