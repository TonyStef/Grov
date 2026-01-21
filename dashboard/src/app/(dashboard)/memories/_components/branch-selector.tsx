'use client';

import { useState, useRef, useEffect, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  ChevronDown,
  Check,
  GitBranch,
  Plus,
  MoreVertical,
  Merge,
  Undo2,
  Trash2,
  Users,
  Loader2,
} from 'lucide-react';
import { setActiveBranch, mergeBranch, unmergeBranch, discardBranch } from '../actions';
import type { Branch } from '@/lib/queries/branches';

interface BranchSelectorProps {
  branches: Branch[];
  activeBranch: string;
  teamId: string;
  userRole: string | null;
  onCreateBranch: () => void;
  onInviteToBranch: (branchName: string) => void;
}

export function BranchSelector({
  branches,
  activeBranch,
  teamId,
  userRole,
  onCreateBranch,
  onInviteToBranch,
}: BranchSelectorProps) {
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [actionMenuBranch, setActionMenuBranch] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<{
    type: 'merge' | 'unmerge' | 'discard';
    branch: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const actionMenuRef = useRef<HTMLDivElement>(null);

  const isAdmin = userRole === 'admin' || userRole === 'owner';

  // Separate branches into categories (backend only returns branches user has access to)
  const mainBranch = branches.find(b => b.name === 'main');
  const activeBranches = branches.filter(b => b.name !== 'main' && b.status === 'active');
  const mergedBranches = branches.filter(b => b.status === 'merged');
  const currentBranch = branches.find(b => b.name === activeBranch) || mainBranch;

  // Close dropdown on outside click
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
      if (actionMenuRef.current && !actionMenuRef.current.contains(event.target as Node)) {
        setActionMenuBranch(null);
      }
    }

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleSelectBranch = async (branchName: string) => {
    if (branchName === activeBranch) {
      setIsOpen(false);
      return;
    }

    setError(null);
    startTransition(async () => {
      const result = await setActiveBranch(teamId, branchName);
      if (result.error) {
        setError(result.error);
      } else {
        setIsOpen(false);
        router.refresh();
      }
    });
  };

  const handleAction = async (type: 'merge' | 'unmerge' | 'discard', branchName: string) => {
    setActionMenuBranch(null);
    setConfirmAction({ type, branch: branchName });
  };

  const executeAction = async () => {
    if (!confirmAction) return;

    setError(null);
    startTransition(async () => {
      let result;
      switch (confirmAction.type) {
        case 'merge':
          result = await mergeBranch(teamId, confirmAction.branch);
          break;
        case 'unmerge':
          result = await unmergeBranch(teamId, confirmAction.branch);
          break;
        case 'discard':
          result = await discardBranch(teamId, confirmAction.branch);
          break;
      }

      if (result?.error) {
        setError(result.error);
      } else {
        setConfirmAction(null);
        router.refresh();
      }
    });
  };

  return (
    <div className="flex items-center gap-2">
      <div className="relative" ref={dropdownRef}>
        {/* Trigger Button */}
        <button
          onClick={() => setIsOpen(!isOpen)}
          disabled={isPending}
          className="flex items-center gap-2 rounded-md border border-border bg-bark px-3 py-1.5 text-xs font-medium text-text-calm hover:bg-moss hover:border-leaf/30 transition-all disabled:opacity-50"
          aria-label="Select branch"
          aria-expanded={isOpen}
          aria-haspopup="listbox"
        >
          <GitBranch className="h-3.5 w-3.5 text-leaf" />
          <span className="max-w-[120px] truncate">{currentBranch?.name || 'main'}</span>
          {isPending ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <ChevronDown className={`h-3 w-3 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
          )}
        </button>

      {/* Dropdown Menu */}
      {isOpen && (
        <div
          className="absolute left-0 top-full z-50 mt-1 w-64 rounded-lg border border-border bg-bg-1 shadow-lg"
          role="listbox"
          aria-label="Branch list"
        >
          {error && (
            <div className="px-3 py-2 text-xs text-error bg-error/10 border-b border-border">
              {error}
            </div>
          )}

          <div className="max-h-80 overflow-y-auto py-1">
            {/* Main Branch */}
            {mainBranch && (
              <BranchOption
                branch={mainBranch}
                isSelected={activeBranch === 'main'}
                onSelect={() => handleSelectBranch('main')}
              />
            )}

            {/* Active Branches */}
            {activeBranches.length > 0 && (
              <>
                <div className="px-3 py-1.5 text-[10px] font-medium uppercase tracking-wider text-text-quiet border-t border-border mt-1">
                  Your Branches
                </div>
                {activeBranches.map(branch => (
                  <div key={branch.name} className="relative group">
                    <BranchOption
                      branch={branch}
                      isSelected={activeBranch === branch.name}
                      onSelect={() => handleSelectBranch(branch.name)}
                    />
                    {isAdmin && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setActionMenuBranch(actionMenuBranch === branch.name ? null : branch.name);
                        }}
                        className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-bark transition-all"
                        aria-label={`Actions for ${branch.name}`}
                      >
                        <MoreVertical className="h-3.5 w-3.5 text-text-quiet" />
                      </button>
                    )}

                    {/* Action Menu */}
                    {actionMenuBranch === branch.name && (
                      <div
                        ref={actionMenuRef}
                        className="absolute right-0 top-full z-50 mt-1 w-40 rounded-md border border-border bg-bg-1 shadow-lg py-1"
                      >
                        <button
                          onClick={() => handleAction('merge', branch.name)}
                          className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-text-calm hover:bg-bark transition-all"
                        >
                          <Merge className="h-3.5 w-3.5" />
                          Merge to main
                        </button>
                        <div className="my-1 border-t border-border" />
                        <button
                          onClick={() => handleAction('discard', branch.name)}
                          className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-error hover:bg-error/10 transition-all"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          Discard branch
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </>
            )}

            {/* Merged Branches */}
            {mergedBranches.length > 0 && (
              <>
                <div className="px-3 py-1.5 text-[10px] font-medium uppercase tracking-wider text-text-quiet border-t border-border mt-1">
                  Merged
                </div>
                {mergedBranches.map(branch => (
                  <div key={branch.name} className="relative group">
                    <button
                      className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-text-quiet hover:bg-bark transition-all"
                      onClick={() => {}}
                      disabled
                    >
                      <GitBranch className="h-3.5 w-3.5 shrink-0 opacity-50" />
                      <span className="flex-1 truncate">{branch.name}</span>
                      <span className="text-[10px] text-text-quiet group-hover:opacity-0 transition-opacity">merged</span>
                    </button>
                    {isAdmin && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setActionMenuBranch(actionMenuBranch === branch.name ? null : branch.name);
                        }}
                        className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-bark transition-all"
                        aria-label={`Actions for ${branch.name}`}
                      >
                        <MoreVertical className="h-3.5 w-3.5 text-text-quiet" />
                      </button>
                    )}

                    {/* Action Menu for Merged Branches */}
                    {actionMenuBranch === branch.name && (
                      <div
                        ref={actionMenuRef}
                        className="absolute right-0 top-full z-50 mt-1 w-40 rounded-md border border-border bg-bg-1 shadow-lg py-1"
                      >
                        <button
                          onClick={() => handleAction('unmerge', branch.name)}
                          className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-text-calm hover:bg-bark transition-all"
                        >
                          <Undo2 className="h-3.5 w-3.5" />
                          Unmerge
                        </button>
                        <div className="my-1 border-t border-border" />
                        <button
                          onClick={() => handleAction('discard', branch.name)}
                          className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-error hover:bg-error/10 transition-all"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          Delete history
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </>
            )}

            {/* Create Branch */}
            <div className="border-t border-border mt-1 pt-1">
              <button
                onClick={() => {
                  setIsOpen(false);
                  onCreateBranch();
                }}
                className="flex w-full items-center gap-2 px-3 py-2 text-xs text-leaf hover:bg-leaf/10 transition-all"
              >
                <Plus className="h-3.5 w-3.5" />
                New Branch
              </button>
            </div>
          </div>
        </div>
      )}
      </div>

      {activeBranch !== 'main' && (
        <button
          onClick={() => onInviteToBranch(activeBranch)}
          className="flex items-center gap-1.5 rounded-md border border-border bg-bark px-2.5 py-1.5 text-xs font-medium text-text-calm hover:bg-moss hover:border-leaf/30 transition-all"
          aria-label={`Invite members to ${activeBranch}`}
        >
          <Users className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Invite</span>
        </button>
      )}

      {confirmAction && (
        <ConfirmActionModal
          type={confirmAction.type}
          branchName={confirmAction.branch}
          isPending={isPending}
          onConfirm={executeAction}
          onCancel={() => setConfirmAction(null)}
          error={error}
        />
      )}
    </div>
  );
}

function BranchOption({
  branch,
  isSelected,
  onSelect,
}: {
  branch: Branch;
  isSelected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      className={`flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-all ${
        isSelected
          ? 'bg-leaf/10 text-leaf'
          : 'text-text-calm hover:bg-bark'
      }`}
      role="option"
      aria-selected={isSelected}
    >
      <GitBranch className="h-3.5 w-3.5 shrink-0" />
      <span className="flex-1 truncate">{branch.name}</span>
      {branch.member_count !== undefined && branch.member_count > 0 && (
        <span className="text-text-quiet group-hover:opacity-0 transition-opacity">{branch.member_count}</span>
      )}
      {isSelected && <Check className="h-3.5 w-3.5 shrink-0 group-hover:opacity-0 transition-opacity" />}
    </button>
  );
}

function ConfirmActionModal({
  type,
  branchName,
  isPending,
  onConfirm,
  onCancel,
  error,
}: {
  type: 'merge' | 'unmerge' | 'discard';
  branchName: string;
  isPending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  error: string | null;
}) {
  const configs = {
    merge: {
      title: 'Merge Branch',
      description: `This will move all memories from "${branchName}" to main. The memories will be visible to all team members.`,
      confirmText: 'Merge to main',
      icon: Merge,
      isDanger: false,
    },
    unmerge: {
      title: 'Unmerge Branch',
      description: `This will move memories back from main to "${branchName}". The memories will only be visible to branch members.`,
      confirmText: 'Unmerge',
      icon: Undo2,
      isDanger: false,
    },
    discard: {
      title: 'Discard Branch',
      description: `This will permanently delete "${branchName}" and all its memories. This action cannot be undone.`,
      confirmText: 'Discard branch',
      icon: Trash2,
      isDanger: true,
    },
  };

  const { title, description, confirmText, icon: Icon, isDanger } = configs[type];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="absolute inset-0 bg-bg-0/80 backdrop-blur-sm"
        onClick={onCancel}
      />
      <div className="relative w-full max-w-md rounded-lg border border-border bg-bg-1 p-6 shadow-xl">
        <div className="flex items-center gap-3 mb-4">
          <div className={`p-2 rounded-lg ${isDanger ? 'bg-error/10' : 'bg-leaf/10'}`}>
            <Icon className={`h-5 w-5 ${isDanger ? 'text-error' : 'text-leaf'}`} />
          </div>
          <h2 className="text-lg font-semibold">{title}</h2>
        </div>

        <p className="text-sm text-text-calm mb-6">{description}</p>

        {error && (
          <div className="mb-4 rounded-md bg-error/10 px-4 py-3 text-sm text-error">
            {error}
          </div>
        )}

        <div className="flex justify-end gap-3">
          <button
            onClick={onCancel}
            disabled={isPending}
            className="rounded-md px-4 py-2 text-sm font-medium text-text-calm hover:bg-bark transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={isPending}
            className={`flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-colors disabled:opacity-50 ${
              isDanger
                ? 'bg-error text-white hover:bg-error/90'
                : 'bg-leaf text-soil hover:bg-bloom'
            }`}
          >
            {isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
