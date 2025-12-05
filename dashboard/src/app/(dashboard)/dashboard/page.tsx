import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Dashboard',
};

export default function DashboardPage() {
  return (
    <div className="animate-fade-in space-y-6">
      {/* Welcome */}
      <div>
        <h1 className="text-2xl font-semibold">Welcome to Grov</h1>
        <p className="mt-1 text-text-secondary">
          Your team&apos;s collective AI memory
        </p>
      </div>

      {/* Stats Grid */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          title="Total Memories"
          value="0"
          description="Captured reasoning"
        />
        <StatCard
          title="Team Members"
          value="1"
          description="Active contributors"
        />
        <StatCard
          title="Files Touched"
          value="0"
          description="Across all sessions"
        />
        <StatCard
          title="This Week"
          value="0"
          description="New memories"
        />
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
            code="grov sync enable"
          />
        </div>
      </div>

      {/* Recent Activity */}
      <div className="rounded-lg border border-border bg-bg-1 p-6">
        <h2 className="mb-4 text-lg font-medium">Recent Activity</h2>
        <div className="flex h-32 items-center justify-center text-text-muted">
          <p>No memories yet. Start a Claude Code session to capture reasoning.</p>
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
