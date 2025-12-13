'use client';

import { useState, useRef, useEffect } from 'react';
import { MoreVertical, Shield, User, UserMinus } from 'lucide-react';

interface MemberActionsMenuProps {
  memberRole: string;
  isOwner: boolean;
  onChangeRole: (role: 'admin' | 'member') => void;
  onRemove: () => void;
}

export function MemberActionsMenu({
  memberRole,
  isOwner,
  onChangeRole,
  onRemove,
}: MemberActionsMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [isOpen]);

  const handleAction = (action: () => void) => {
    setIsOpen(false);
    action();
  };

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="rounded p-1 text-text-muted hover:bg-bg-2 hover:text-text-primary"
      >
        <MoreVertical className="h-4 w-4" />
      </button>

      {isOpen && (
        <div className="absolute right-0 top-full z-20 mt-1 w-48 rounded-md border border-border bg-bg-1 py-1 shadow-lg">
          {isOwner && (
            <>
              {memberRole === 'member' && (
                <button
                  onClick={() => handleAction(() => onChangeRole('admin'))}
                  className="flex w-full items-center gap-2 px-3 py-2 text-sm text-text-secondary hover:bg-bg-2 hover:text-text-primary"
                >
                  <Shield className="h-4 w-4" />
                  Promote to Admin
                </button>
              )}
              {memberRole === 'admin' && (
                <button
                  onClick={() => handleAction(() => onChangeRole('member'))}
                  className="flex w-full items-center gap-2 px-3 py-2 text-sm text-text-secondary hover:bg-bg-2 hover:text-text-primary"
                >
                  <User className="h-4 w-4" />
                  Demote to Member
                </button>
              )}
              <div className="my-1 border-t border-border" />
            </>
          )}
          <button
            onClick={() => handleAction(onRemove)}
            className="flex w-full items-center gap-2 px-3 py-2 text-sm text-error hover:bg-error/10"
          >
            <UserMinus className="h-4 w-4" />
            Remove from Team
          </button>
        </div>
      )}
    </div>
  );
}
