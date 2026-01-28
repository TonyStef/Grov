'use client';

import { useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import Image from 'next/image';
import { X, Plus, Trash2, Upload, FileText, Check } from 'lucide-react';
import { createPlan } from '../actions';
import { getInitials } from '@/lib/utils';
import type { PlanPriority, PlanTargetType } from '@grov/shared';

interface TeamMember {
  user_id: string;
  email: string;
  full_name: string | null;
  avatar_url: string | null;
}

interface CreatePlanModalProps {
  teamId: string;
  teamMembers: TeamMember[];
  onClose: () => void;
}

export function CreatePlanModal({ teamId, teamMembers, onClose }: CreatePlanModalProps) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [priority, setPriority] = useState<PlanPriority>('normal');
  const [targetType, setTargetType] = useState<PlanTargetType>('all');
  const [selectedUserIds, setSelectedUserIds] = useState<string[]>([]);
  const [tasks, setTasks] = useState<{ title: string; description: string }[]>([]);
  const [fileName, setFileName] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const toggleUser = (userId: string) => {
    setSelectedUserIds(prev =>
      prev.includes(userId)
        ? prev.filter(id => id !== userId)
        : [...prev, userId]
    );
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.name.endsWith('.md') && !file.name.endsWith('.txt')) {
      setError('Please upload a .md or .txt file');
      return;
    }

    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target?.result as string;
      setContent(text);
      setFileName(file.name);
      if (!title.trim()) {
        setTitle(file.name.replace(/\.(md|txt)$/, ''));
      }
    };
    reader.onerror = () => {
      setError('Failed to read file');
    };
    reader.readAsText(file);
  };

  const clearFile = () => {
    setFileName(null);
    setContent('');
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const addTask = () => {
    setTasks([...tasks, { title: '', description: '' }]);
  };

  const removeTask = (index: number) => {
    setTasks(tasks.filter((_, i) => i !== index));
  };

  const updateTask = (index: number, field: 'title' | 'description', value: string) => {
    const updated = [...tasks];
    updated[index][field] = value;
    setTasks(updated);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;

    setLoading(true);
    setError(null);

    const input = {
      title: title.trim(),
      content: content.trim(),
      priority,
      target_type: targetType,
      target_user_ids: targetType === 'specific' ? selectedUserIds : undefined,
      tasks: tasks.filter(t => t.title.trim()).map((t, i) => ({
        title: t.title.trim(),
        description: t.description.trim() || undefined,
        order_index: i,
      })),
    };

    const result = await createPlan(teamId, input);

    if (result.error) {
      setError(result.error);
      setLoading(false);
      return;
    }

    router.refresh();
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-soil/80 backdrop-blur-sm">
      <div className="w-full max-w-lg rounded-lg border border-border bg-root p-6 shadow-xl">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-text-bright">Create Plan</h2>
          <button
            onClick={onClose}
            className="rounded p-1 text-text-quiet hover:bg-bark hover:text-text-calm transition-all"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-text-calm mb-1">Title</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Sprint 42 Release"
              className="w-full rounded-lg border border-border bg-bark px-3 py-2 text-sm text-text-bright placeholder:text-text-quiet focus:border-leaf focus:outline-none"
              required
            />
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs font-medium text-text-calm">Content</label>
              <input
                ref={fileInputRef}
                type="file"
                accept=".md,.txt"
                onChange={handleFileUpload}
                className="hidden"
              />
              {fileName ? (
                <div className="flex items-center gap-2">
                  <span className="flex items-center gap-1 text-xs text-leaf">
                    <FileText className="h-3 w-3" />
                    {fileName}
                  </span>
                  <button
                    type="button"
                    onClick={clearFile}
                    className="text-xs text-text-quiet hover:text-error transition-all"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="flex items-center gap-1 text-xs text-leaf hover:text-bloom transition-all"
                >
                  <Upload className="h-3 w-3" />
                  Upload .md
                </button>
              )}
            </div>
            <textarea
              value={content}
              onChange={(e) => {
                setContent(e.target.value);
                if (fileName) setFileName(null);
              }}
              placeholder="Describe the plan objectives, or upload a markdown file..."
              rows={5}
              className="w-full rounded-lg border border-border bg-bark px-3 py-2 text-sm text-text-bright placeholder:text-text-quiet focus:border-leaf focus:outline-none resize-none font-mono"
            />
            {content && (
              <p className="mt-1 text-[10px] text-text-quiet">
                {content.length} characters
              </p>
            )}
          </div>

          <div>
            <label className="block text-xs font-medium text-text-calm mb-1">Priority</label>
            <select
              value={priority}
              onChange={(e) => setPriority(e.target.value as PlanPriority)}
              className="w-full rounded-lg border border-border bg-bark px-3 py-2 text-sm text-text-bright focus:border-leaf focus:outline-none"
            >
              <option value="low">Low</option>
              <option value="normal">Normal</option>
              <option value="high">High</option>
              <option value="urgent">Urgent</option>
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-text-calm mb-2">Visibility</label>
            <div className="flex gap-2 mb-2">
              <button
                type="button"
                onClick={() => setTargetType('all')}
                className={`flex-1 rounded-lg border px-3 py-2 text-xs font-medium transition-all ${
                  targetType === 'all'
                    ? 'border-leaf bg-leaf/10 text-leaf'
                    : 'border-border bg-bark text-text-calm hover:border-leaf/30'
                }`}
              >
                Everyone
              </button>
              <button
                type="button"
                onClick={() => setTargetType('specific')}
                className={`flex-1 rounded-lg border px-3 py-2 text-xs font-medium transition-all ${
                  targetType === 'specific'
                    ? 'border-leaf bg-leaf/10 text-leaf'
                    : 'border-border bg-bark text-text-calm hover:border-leaf/30'
                }`}
              >
                Specific people
              </button>
            </div>
            {targetType === 'specific' && (
              <div className="space-y-1 max-h-32 overflow-y-auto rounded-lg border border-border bg-bark p-2">
                {teamMembers.map((member) => (
                  <button
                    key={member.user_id}
                    type="button"
                    onClick={() => toggleUser(member.user_id)}
                    className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-all ${
                      selectedUserIds.includes(member.user_id)
                        ? 'bg-leaf/10'
                        : 'hover:bg-root'
                    }`}
                  >
                    {member.avatar_url ? (
                      <Image
                        src={member.avatar_url}
                        alt=""
                        width={20}
                        height={20}
                        className="rounded"
                      />
                    ) : (
                      <div className="h-5 w-5 rounded bg-leaf/10 text-[9px] flex items-center justify-center text-leaf font-medium">
                        {getInitials(member.full_name || member.email)}
                      </div>
                    )}
                    <span className="flex-1 text-xs text-text-bright truncate">
                      {member.full_name || member.email}
                    </span>
                    {selectedUserIds.includes(member.user_id) && (
                      <Check className="h-3.5 w-3.5 text-leaf" />
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-medium text-text-calm">Tasks</label>
              <button
                type="button"
                onClick={addTask}
                className="flex items-center gap-1 text-xs text-leaf hover:text-bloom transition-all"
              >
                <Plus className="h-3 w-3" />
                Add Task
              </button>
            </div>
            <div className="space-y-2 max-h-40 overflow-y-auto">
              {tasks.map((task, index) => (
                <div key={index} className="flex items-start gap-2">
                  <input
                    type="text"
                    value={task.title}
                    onChange={(e) => updateTask(index, 'title', e.target.value)}
                    placeholder={`Task ${index + 1}`}
                    className="flex-1 rounded-lg border border-border bg-bark px-3 py-1.5 text-sm text-text-bright placeholder:text-text-quiet focus:border-leaf focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => removeTask(index)}
                    className="rounded p-1.5 text-text-quiet hover:bg-error/10 hover:text-error transition-all"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </div>

          {error && (
            <p className="text-xs text-error">{error}</p>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg px-3 py-1.5 text-xs font-medium text-text-calm hover:bg-bark transition-all"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || !title.trim()}
              className="rounded-lg bg-leaf px-3 py-1.5 text-xs font-medium text-soil hover:bg-bloom transition-all disabled:opacity-50"
            >
              {loading ? 'Creating...' : 'Create Plan'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

