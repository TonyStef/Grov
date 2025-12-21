'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Search, Command, LogOut, Settings } from 'lucide-react';
import { CommandMenu } from './command-menu';
import { createClient } from '@/lib/supabase/client';
import { getInitials } from '@/lib/utils';
import type { CurrentUser } from '@/lib/queries/profiles';

interface HeaderProps {
  user: CurrentUser | null;
}

export function Header({ user }: HeaderProps) {
  const router = useRouter();
  const [commandMenuOpen, setCommandMenuOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);

  const handleLogout = async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
    Object.keys(localStorage)
      .filter((key) => key.startsWith('grov-'))
      .forEach((key) => localStorage.removeItem(key));
    window.location.href = '/login';
  };

  return (
    <>
      <header className="flex h-12 items-center justify-between border-b border-border bg-root px-4">
        <button
          onClick={() => setCommandMenuOpen(true)}
          className="flex items-center gap-2 rounded-lg border border-border bg-bark px-3 py-1.5 text-xs text-text-quiet transition-all hover:border-leaf/30 hover:text-text-calm"
        >
          <Search className="h-3.5 w-3.5" />
          <span>Search memories...</span>
          <kbd className="ml-auto flex items-center gap-0.5 rounded bg-moss px-1.5 py-0.5 font-mono text-[10px] text-text-calm">
            <Command className="h-2.5 w-2.5" />K
          </kbd>
        </button>

        <div className="flex items-center gap-2">
          <div className="relative">
            <button
              onClick={() => setUserMenuOpen(!userMenuOpen)}
              className="flex items-center gap-2 rounded-lg p-1 transition-all hover:bg-bark"
            >
              {user?.avatar_url ? (
                <img
                  src={user.avatar_url}
                  alt={user.full_name || user.email}
                  className="h-6 w-6 rounded"
                />
              ) : (
                <div className="flex h-6 w-6 items-center justify-center rounded bg-leaf/10 text-[10px] font-medium text-leaf">
                  {getInitials(user?.full_name || user?.email)}
                </div>
              )}
            </button>

            {userMenuOpen && (
              <>
                <div
                  className="fixed inset-0 z-10"
                  onClick={() => setUserMenuOpen(false)}
                />

                <div className="absolute right-0 top-full z-20 mt-1 w-48 rounded-lg border border-border bg-root py-1 shadow-lg">
                  <div className="border-b border-border px-3 py-2">
                    <p className="text-xs font-medium text-text-bright">
                      {user?.full_name || 'User'}
                    </p>
                    <p className="text-[10px] text-text-quiet truncate">
                      {user?.email}
                    </p>
                  </div>

                  <div className="py-1">
                    <button
                      onClick={() => {
                        setUserMenuOpen(false);
                        router.push('/settings');
                      }}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-text-calm hover:bg-bark hover:text-text-bright transition-colors"
                    >
                      <Settings className="h-3.5 w-3.5" />
                      Settings
                    </button>
                    <button
                      onClick={handleLogout}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-error hover:bg-error/10 transition-colors"
                    >
                      <LogOut className="h-3.5 w-3.5" />
                      Log out
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </header>

      <CommandMenu open={commandMenuOpen} onOpenChange={setCommandMenuOpen} onSignOut={handleLogout} />
    </>
  );
}
