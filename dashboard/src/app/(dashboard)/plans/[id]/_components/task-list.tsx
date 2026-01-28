'use client';

import { useState, useEffect } from 'react';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { Circle, CheckCircle2, Loader2, AlertCircle, Plus, Lock, ChevronDown } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { claimTask, completeTask, createTask } from '../../actions';
import { getInitials } from '@/lib/utils';
import type { PlanTask } from '@grov/shared';

interface TeamMember {
  user_id: string;
  email: string;
  full_name: string | null;
  avatar_url: string | null;
}

interface TaskListProps {
  teamId: string;
  planId: string;
  tasks: PlanTask[];
  currentUserId: string;
  teamMembers: TeamMember[];
  canEdit: boolean;
}

const STATUS_ICONS: Record<string, React.ReactNode> = {
  pending: <Circle className="h-4 w-4 text-text-quiet" />,
  in_progress: <Loader2 className="h-4 w-4 text-warning" />,
  blocked: <AlertCircle className="h-4 w-4 text-error" />,
  completed: <CheckCircle2 className="h-4 w-4 text-success" />,
  skipped: <Circle className="h-4 w-4 text-text-quiet line-through" />,
};

export function TaskList({ teamId, planId, tasks, currentUserId, teamMembers, canEdit }: TaskListProps) {
  const router = useRouter();
  const [loading, setLoading] = useState<string | null>(null);
  const [showAddTask, setShowAddTask] = useState(false);
  const [newTaskTitle, setNewTaskTitle] = useState('');
  const [newTaskDeps, setNewTaskDeps] = useState<string[]>([]);
  const [showDepsPicker, setShowDepsPicker] = useState(false);

  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel(`plan_tasks:${planId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'plan_tasks', filter: `plan_id=eq.${planId}` },
        () => router.refresh()
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [planId, router]);

  const taskById = new Map(tasks.map(t => [t.id, t]));
  const getBlockers = (task: PlanTask): PlanTask[] => {
    if (!task.depends_on?.length) return [];
    return task.depends_on
      .map(id => taskById.get(id))
      .filter((t): t is PlanTask => !!t && t.status !== 'completed' && t.status !== 'skipped');
  };

  const getMemberInfo = (userId: string | null) => {
    if (!userId) return null;
    return teamMembers.find(m => m.user_id === userId);
  };

  const handleClaim = async (taskId: string) => {
    setLoading(taskId);
    await claimTask(teamId, planId, taskId);
    router.refresh();
    setLoading(null);
  };

  const handleComplete = async (taskId: string) => {
    setLoading(taskId);
    await completeTask(teamId, planId, taskId);
    router.refresh();
    setLoading(null);
  };

  const handleAddTask = async () => {
    if (!newTaskTitle.trim()) return;
    setLoading('new');
    await createTask(teamId, planId, {
      title: newTaskTitle.trim(),
      order_index: tasks.length,
      depends_on: newTaskDeps.length > 0 ? newTaskDeps : undefined,
    });
    setNewTaskTitle('');
    setNewTaskDeps([]);
    setShowAddTask(false);
    setShowDepsPicker(false);
    router.refresh();
    setLoading(null);
  };

  const toggleDep = (taskId: string) => {
    setNewTaskDeps(prev =>
      prev.includes(taskId)
        ? prev.filter(id => id !== taskId)
        : [...prev, taskId]
    );
  };

  const availableForDeps = tasks.filter(t => t.status !== 'completed' && t.status !== 'skipped');

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-text-bright">Tasks</h2>
        {canEdit && (
          <button
            onClick={() => setShowAddTask(true)}
            className="flex items-center gap-1 text-xs text-leaf hover:text-bloom transition-all"
          >
            <Plus className="h-3 w-3" />
            Add Task
          </button>
        )}
      </div>

      {tasks.length === 0 && !showAddTask ? (
        <div className="rounded-lg border border-dashed border-border bg-root/50 py-6 text-center">
          <p className="text-xs text-text-calm">No tasks yet</p>
        </div>
      ) : (
        <div className="space-y-1">
          {tasks.map((task) => {
            const claimedBy = getMemberInfo(task.claimed_by);
            const isClaimedByMe = task.claimed_by === currentUserId;
            const blockers = getBlockers(task);
            const isBlocked = blockers.length > 0;
            const canClaim = task.status === 'pending' && !task.claimed_by && !isBlocked;
            const canComplete = task.status === 'in_progress' && isClaimedByMe;

            return (
              <div
                key={task.id}
                className={`flex items-center gap-3 rounded-lg border p-3 transition-all ${
                  isBlocked
                    ? 'border-border/50 bg-bark/50 opacity-75'
                    : 'border-border bg-root hover:border-leaf/30'
                }`}
              >
                <div className="shrink-0">
                  {isBlocked ? (
                    <Lock className="h-4 w-4 text-text-quiet" />
                  ) : (
                    STATUS_ICONS[task.status]
                  )}
                </div>

                <div className="flex-1 min-w-0">
                  <p className={`text-sm ${task.status === 'completed' ? 'text-text-quiet line-through' : isBlocked ? 'text-text-calm' : 'text-text-bright'}`}>
                    {task.title}
                  </p>
                  {task.description && (
                    <p className="text-xs text-text-quiet mt-0.5">{task.description}</p>
                  )}
                  {isBlocked && (
                    <p className="text-[10px] text-text-quiet mt-1">
                      Blocked by: {blockers.map(t => t.title).join(', ')}
                    </p>
                  )}
                </div>

                {claimedBy && (
                  <div className="flex items-center gap-1.5 shrink-0">
                    {claimedBy.avatar_url ? (
                      <Image
                        src={claimedBy.avatar_url}
                        alt=""
                        width={20}
                        height={20}
                        className="rounded"
                      />
                    ) : (
                      <div className="h-5 w-5 rounded bg-leaf/10 text-[9px] flex items-center justify-center text-leaf font-medium">
                        {getInitials(claimedBy.full_name || claimedBy.email)}
                      </div>
                    )}
                    <span className="text-xs text-text-calm">{claimedBy.full_name || 'Unknown'}</span>
                  </div>
                )}

                <div className="flex items-center gap-1 shrink-0">
                  {canClaim && (
                    <button
                      onClick={() => handleClaim(task.id)}
                      disabled={loading === task.id}
                      className="rounded px-2 py-1 text-[11px] font-medium bg-warning/10 text-warning hover:bg-warning/20 transition-all disabled:opacity-50"
                    >
                      {loading === task.id ? '...' : 'Claim'}
                    </button>
                  )}
                  {canComplete && (
                    <button
                      onClick={() => handleComplete(task.id)}
                      disabled={loading === task.id}
                      className="rounded px-2 py-1 text-[11px] font-medium bg-success/10 text-success hover:bg-success/20 transition-all disabled:opacity-50"
                    >
                      {loading === task.id ? '...' : 'Complete'}
                    </button>
                  )}
                </div>
              </div>
            );
          })}

          {showAddTask && (
            <div className="rounded-lg border border-leaf/30 bg-root p-3 space-y-2">
              <input
                type="text"
                value={newTaskTitle}
                onChange={(e) => setNewTaskTitle(e.target.value)}
                placeholder="New task title..."
                className="w-full bg-transparent text-sm text-text-bright placeholder:text-text-quiet focus:outline-none"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !showDepsPicker) handleAddTask();
                  if (e.key === 'Escape') {
                    setShowAddTask(false);
                    setShowDepsPicker(false);
                    setNewTaskDeps([]);
                  }
                }}
              />
              {availableForDeps.length > 0 && (
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setShowDepsPicker(!showDepsPicker)}
                    className="flex items-center gap-1 text-[11px] text-text-quiet hover:text-text-calm transition-all"
                  >
                    <Lock className="h-3 w-3" />
                    {newTaskDeps.length > 0
                      ? `Depends on ${newTaskDeps.length} task${newTaskDeps.length > 1 ? 's' : ''}`
                      : 'Add dependency'}
                    <ChevronDown className={`h-3 w-3 transition-transform ${showDepsPicker ? 'rotate-180' : ''}`} />
                  </button>
                  {showDepsPicker && (
                    <div className="absolute left-0 top-full mt-1 z-10 w-64 max-h-40 overflow-y-auto rounded-lg border border-border bg-bark p-1 shadow-lg">
                      {availableForDeps.map((t) => (
                        <button
                          key={t.id}
                          type="button"
                          onClick={() => toggleDep(t.id)}
                          className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs transition-all ${
                            newTaskDeps.includes(t.id) ? 'bg-leaf/10 text-leaf' : 'text-text-calm hover:bg-root'
                          }`}
                        >
                          <span className={`h-3 w-3 rounded border flex items-center justify-center ${
                            newTaskDeps.includes(t.id) ? 'border-leaf bg-leaf' : 'border-border'
                          }`}>
                            {newTaskDeps.includes(t.id) && <CheckCircle2 className="h-2 w-2 text-soil" />}
                          </span>
                          <span className="truncate">{t.title}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
              <div className="flex items-center gap-2">
                <button
                  onClick={handleAddTask}
                  disabled={loading === 'new' || !newTaskTitle.trim()}
                  className="rounded px-2 py-1 text-[11px] font-medium bg-leaf text-soil hover:bg-bloom transition-all disabled:opacity-50"
                >
                  {loading === 'new' ? '...' : 'Add'}
                </button>
                <button
                  onClick={() => {
                    setShowAddTask(false);
                    setShowDepsPicker(false);
                    setNewTaskDeps([]);
                  }}
                  className="rounded px-2 py-1 text-[11px] font-medium text-text-calm hover:bg-bark transition-all"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

