// Memory detail page - Shows full reasoning trace and details

import type { Metadata } from 'next';
import { createClient } from '@/lib/supabase/server';
import { notFound } from 'next/navigation';
import { MemoryHeader } from './_components/memory-header';
import { ReasoningTrace } from './_components/reasoning-trace';
import { FilesTouched } from './_components/files-touched';
import { DecisionsList } from './_components/decisions-list';
import { MemoryTabs } from './_components/memory-tabs';
import { EvolutionTimeline } from './_components/evolution-timeline';
import { PreviousReasoning } from './_components/previous-reasoning';
import Link from 'next/link';

interface MemoryPageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: MemoryPageProps): Promise<Metadata> {
  const { id } = await params;
  return {
    title: `Memory ${id.slice(0, 8)}... | Grov`,
  };
}

export default async function MemoryPage({ params }: MemoryPageProps) {
  const { id } = await params;
  const supabase = await createClient();

  // Fetch memory with user profile
  const { data: memory, error } = await supabase
    .from('memories')
    .select(`
      *,
      profile:profiles!user_id (
        full_name,
        avatar_url,
        email
      )
    `)
    .eq('id', id)
    .single();

  if (error || !memory) {
    notFound();
  }

  return (
    <div className="animate-fade-in space-y-6">
      {/* Back button */}
      <Link
        href="/memories"
        className="inline-flex items-center gap-2 text-sm text-text-secondary hover:text-text-primary transition-colors"
      >
        <svg
          className="h-4 w-4"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M15 19l-7-7 7-7"
          />
        </svg>
        Back to Memories
      </Link>

      {/* Memory header */}
      <MemoryHeader memory={memory} />

      {/* Show tabs only if memory has history, otherwise show content directly */}
      {(memory.evolution_steps?.length || 0) > 0 ? (
        <MemoryTabs
          latestContent={
            <div className="grid gap-6 lg:grid-cols-3">
              <div className="lg:col-span-2">
                <ReasoningTrace trace={memory.reasoning_trace || []} />
              </div>
              <Sidebar memory={memory} />
            </div>
          }
          historyContent={
            <div className="grid gap-6 lg:grid-cols-3">
              <div className="lg:col-span-2 space-y-6">
                <EvolutionTimeline steps={memory.evolution_steps || []} />
                <PreviousReasoning entries={memory.reasoning_evolution || []} />
              </div>
              <Sidebar memory={memory} showSuperseded={true} />
            </div>
          }
        />
      ) : (
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="lg:col-span-2">
            <ReasoningTrace trace={memory.reasoning_trace || []} />
          </div>
          <Sidebar memory={memory} />
        </div>
      )}
    </div>
  );
}

// Sidebar component - shared between Latest and History tabs
// showSuperseded: false for Latest (active only), true for History (all with visual distinction)
function Sidebar({ memory, showSuperseded = false }: { memory: any; showSuperseded?: boolean }) {
  return (
    <div className="space-y-6">
      <FilesTouched files={memory.files_touched || []} />
      <DecisionsList decisions={memory.decisions || []} showSuperseded={showSuperseded} />

      {/* Constraints */}
      {memory.constraints && memory.constraints.length > 0 && (
        <div className="rounded-lg border border-border bg-bg-1 p-4">
          <h3 className="mb-3 font-medium text-text-primary">Constraints</h3>
          <ul className="space-y-2">
            {memory.constraints.map((constraint: string, i: number) => (
              <li
                key={i}
                className="flex items-start gap-2 text-sm text-text-secondary"
              >
                <span className="text-warning">!</span>
                {constraint}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Tags */}
      {memory.tags && memory.tags.length > 0 && (
        <div className="rounded-lg border border-border bg-bg-1 p-4">
          <h3 className="mb-3 font-medium text-text-primary">Tags</h3>
          <div className="flex flex-wrap gap-2">
            {memory.tags.map((tag: string) => (
              <span
                key={tag}
                className="rounded-full bg-bg-2 px-2.5 py-1 text-xs text-text-secondary"
              >
                {tag}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Linked commit */}
      {memory.linked_commit && (
        <div className="rounded-lg border border-border bg-bg-1 p-4">
          <h3 className="mb-3 font-medium text-text-primary">Linked Commit</h3>
          <code className="text-sm font-mono text-accent-400">
            {memory.linked_commit.slice(0, 7)}
          </code>
        </div>
      )}
    </div>
  );
}
