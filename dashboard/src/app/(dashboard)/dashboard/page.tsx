import type { Metadata } from 'next';
import Link from 'next/link';
import { Brain, ChevronRight } from 'lucide-react';
import { getDashboardData } from '@/lib/queries/dashboard-rpc';
import { formatRelativeDate, truncate, getInitials } from '@/lib/utils';

export const metadata: Metadata = {
  title: 'Dashboard',
};

export default async function DashboardPage() {
  // Single RPC call replaces ~12 sequential queries
  const data = await getDashboardData();

  // Handle auth error or no data
  if (!data || !data.user) {
    return <NoTeamDashboard userName={null} />;
  }

  // No team - show welcome screen
  if (!data.current_team || data.teams.length === 0) {
    return <NoTeamDashboard userName={data.user.full_name} />;
  }

  const { user, current_team: team, stats, recent_memories: recentMemories } = data;

  return (
    <div className="relative min-h-full">
      <div className="animate-grow-in space-y-5 p-6">
        <header>
          <h1 className="text-xl font-semibold">
            Welcome back{user.full_name ? `, ${user.full_name.split(' ')[0]}` : ''}
          </h1>
          <p className="text-sm text-text-calm">
            {team.name}&apos;s collective AI memory
          </p>
        </header>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 stagger-children">
          <StatCard
            title="Total Memories"
            value={stats.total_memories.toString()}
            description="Captured reasoning"
          />
          <StatCard
            title="Team Members"
            value={stats.team_members.toString()}
            description="Active contributors"
          />
          <StatCard
            title="Files Touched"
            value={stats.files_touched.toString()}
            description="Across all sessions"
          />
          <StatCard
            title="This Week"
            value={stats.this_week.toString()}
            description="New memories"
          />
        </div>

        <div className="grid gap-4 lg:grid-cols-5">
          <div className="lg:col-span-3 rounded-xl border border-border bg-root p-4">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold">Recent Activity</h2>
              {recentMemories.length > 0 && (
                <Link
                  href="/memories"
                  className="flex items-center gap-1 text-xs text-leaf hover:text-bloom transition-colors"
                >
                  View all
                  <ChevronRight className="h-3 w-3" />
                </Link>
              )}
            </div>

            {recentMemories.length === 0 ? (
              <div className="flex h-28 items-center justify-center text-text-quiet">
                <div className="text-center">
                  <Brain className="h-5 w-5 text-leaf mx-auto mb-2" />
                  <p className="text-xs text-text-calm">No memories yet</p>
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                {recentMemories.map((memory) => (
                  <Link
                    key={memory.id}
                    href={`/memories/${memory.id}`}
                    className="block rounded-lg bg-bark border border-transparent p-3 transition-all hover:border-leaf/20 hover:bg-moss"
                  >
                    <p className="text-xs font-medium text-text-bright line-clamp-1">
                      {truncate(memory.original_query, 60)}
                    </p>
                    <div className="mt-1.5 flex items-center gap-2 text-[11px] text-text-quiet">
                      {memory.profile?.avatar_url ? (
                        <img
                          src={memory.profile.avatar_url}
                          alt=""
                          className="h-4 w-4 rounded-full"
                        />
                      ) : (
                        <div className="h-4 w-4 rounded bg-leaf/10 text-[8px] flex items-center justify-center text-leaf font-medium">
                          {getInitials(memory.profile?.full_name || memory.profile?.email)}
                        </div>
                      )}
                      <span className="text-text-calm">{memory.profile?.full_name || 'Unknown'}</span>
                      <span className="w-0.5 h-0.5 rounded-full bg-moss" />
                      <span>{formatRelativeDate(memory.created_at)}</span>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </div>

          <div className="lg:col-span-2 rounded-xl border border-border bg-root p-4">
            <h2 className="mb-3 text-sm font-semibold">Getting Started</h2>
            <div className="space-y-3">
              <Step
                number={1}
                title="Install the CLI"
                description="Run this command in your terminal"
                code="npm install -g grov"
              />
              <Step
                number={2}
                title="Login and enable sync"
                description="Connect your CLI and start capturing"
                code="grov login"
              />
              <Step
                number={3}
                title="Start the proxy"
                description="Initialize and run the proxy in your project"
                code="grov init && grov proxy"
              />
              <Step
                number={4}
                title="Start coding"
                description="Open a new terminal tab and run Claude"
                code="claude"
              />
            </div>
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
    <div className="rounded-lg border border-border bg-root p-3 hover-lift">
      <p className="text-xs text-text-calm">{title}</p>
      <p className="mt-1 text-2xl font-semibold tracking-tight">{value}</p>
      <p className="text-[11px] text-text-quiet">{description}</p>
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
    <div className="flex gap-3">
      <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-leaf/10 font-mono text-xs font-semibold text-leaf">
        {number}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium text-text-bright">{title}</p>
        <p className="text-[11px] text-text-calm">{description}</p>
        <code className="mt-1.5 block rounded-md bg-bark border border-border px-2.5 py-1.5 font-mono text-[11px] text-leaf truncate">
          {code}
        </code>
      </div>
    </div>
  );
}

function NoTeamDashboard({ userName }: { userName?: string | null }) {
  return (
    <div className="relative min-h-full">
      <div className="animate-grow-in space-y-5 p-6">
        <header>
          <h1 className="text-xl font-semibold">
            Welcome{userName ? `, ${userName.split(' ')[0]}` : ' to Grov'}
          </h1>
          <p className="text-sm text-text-calm">
            Let&apos;s get you set up with your team
          </p>
        </header>

        <div className="flex flex-col items-center justify-center py-10">
          <div className="relative h-14 w-14">
            <div className="absolute inset-0 rounded-xl bg-leaf/20 blur-md" />
            <div className="relative h-full w-full rounded-xl bg-seed flex items-center justify-center">
              <span className="text-xl font-bold text-bloom">g</span>
            </div>
          </div>
          <h2 className="mt-5 text-lg font-semibold">
            Create Your First Team
          </h2>
          <p className="mt-2 text-center text-sm text-text-calm max-w-md">
            Teams let you share AI reasoning with your collaborators. Create a team
            to start capturing memories from your Claude Code sessions.
          </p>
          <Link
            href="/team"
            className="mt-5 inline-flex items-center rounded-lg bg-leaf px-5 py-2 text-xs font-semibold text-soil transition-all hover:bg-bloom"
          >
            Create Team
          </Link>
        </div>

        <div className="rounded-xl border border-border bg-root p-4 opacity-50">
          <h2 className="mb-3 text-sm font-semibold">Next Steps (after team creation)</h2>
          <div className="space-y-3">
            <Step
              number={1}
              title="Install the CLI"
              description="Run this command in your terminal"
              code="npm install -g grov"
            />
            <Step
              number={2}
              title="Login and enable sync"
              description="Connect your CLI and start capturing"
              code="grov login"
            />
            <Step
              number={3}
              title="Start the proxy"
              description="Initialize and run the proxy in your project"
              code="grov init && grov proxy"
            />
            <Step
              number={4}
              title="Start coding"
              description="Open a new terminal tab and run Claude"
              code="claude"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
