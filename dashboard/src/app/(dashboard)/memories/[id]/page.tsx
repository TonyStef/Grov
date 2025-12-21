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
    <div className="animate-grow-in space-y-4 p-6">
      <Link
        href="/memories"
        className="inline-flex items-center gap-1.5 text-xs text-text-calm hover:text-text-bright transition-colors"
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

      <MemoryHeader memory={memory} />

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

function Sidebar({ memory, showSuperseded = false }: { memory: any; showSuperseded?: boolean }) {
  return (
    <div className="space-y-3">
      <FilesTouched files={memory.files_touched || []} />
      <DecisionsList decisions={memory.decisions || []} showSuperseded={showSuperseded} />

      {memory.constraints && memory.constraints.length > 0 && (
        <div className="rounded-lg border border-border bg-root p-3">
          <h3 className="mb-2 text-xs font-semibold text-text-bright">Constraints</h3>
          <ul className="space-y-1.5">
            {memory.constraints.map((constraint: string, i: number) => (
              <li
                key={i}
                className="flex items-start gap-1.5 text-[11px] text-text-calm"
              >
                <span className="text-warning">!</span>
                {constraint}
              </li>
            ))}
          </ul>
        </div>
      )}

      {memory.tags && memory.tags.length > 0 && (
        <div className="rounded-lg border border-border bg-root p-3">
          <h3 className="mb-2 text-xs font-semibold text-text-bright">Tags</h3>
          <div className="flex flex-wrap gap-1.5">
            {memory.tags.map((tag: string) => (
              <span
                key={tag}
                className="rounded bg-bark px-1.5 py-0.5 text-[10px] text-text-calm"
              >
                {tag}
              </span>
            ))}
          </div>
        </div>
      )}

      {memory.linked_commit && (
        <div className="rounded-lg border border-border bg-root p-3">
          <h3 className="mb-2 text-xs font-semibold text-text-bright">Linked Commit</h3>
          <code className="text-[11px] font-mono text-leaf">
            {memory.linked_commit.slice(0, 7)}
          </code>
        </div>
      )}
    </div>
  );
}
