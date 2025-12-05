'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Search, Command, Bell, User, LogOut, Settings } from 'lucide-react';
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
    router.push('/login');
  };

  return (
    <>
      <header className="flex h-16 items-center justify-between border-b border-border bg-bg-1 px-6">
        {/* Search */}
        <button
          onClick={() => setCommandMenuOpen(true)}
          className="flex items-center gap-3 rounded-md border border-border bg-bg-2 px-4 py-2 text-sm text-text-muted transition-colors hover:border-border-hover hover:text-text-secondary"
        >
          <Search className="h-4 w-4" />
          <span>Search memories...</span>
          <kbd className="ml-auto flex items-center gap-1 rounded bg-bg-3 px-2 py-0.5 font-mono text-xs">
            <Command className="h-3 w-3" />K
          </kbd>
        </button>

        {/* Right side */}
        <div className="flex items-center gap-4">
          {/* Notifications */}
          <button className="relative rounded-md p-2 text-text-muted transition-colors hover:bg-bg-2 hover:text-text-primary">
            <Bell className="h-5 w-5" />
          </button>

          {/* User menu */}
          <div className="relative">
            <button
              onClick={() => setUserMenuOpen(!userMenuOpen)}
              className="flex items-center gap-2 rounded-md p-2 text-text-muted transition-colors hover:bg-bg-2 hover:text-text-primary"
            >
              {user?.avatar_url ? (
                <img
                  src={user.avatar_url}
                  alt={user.full_name || user.email}
                  className="h-8 w-8 rounded-full"
                />
              ) : (
                <div className="flex h-8 w-8 items-center justify-center rounded-full bg-accent-400/20 text-xs font-medium text-accent-400">
                  {getInitials(user?.full_name || user?.email)}
                </div>
              )}
            </button>

            {/* User dropdown */}
            {userMenuOpen && (
              <>
                {/* Backdrop */}
                <div
                  className="fixed inset-0 z-10"
                  onClick={() => setUserMenuOpen(false)}
                />

                {/* Menu */}
                <div className="absolute right-0 top-full z-20 mt-2 w-56 rounded-md border border-border bg-bg-1 py-1 shadow-lg">
                  {/* User info */}
                  <div className="border-b border-border px-4 py-3">
                    <p className="text-sm font-medium text-text-primary">
                      {user?.full_name || 'User'}
                    </p>
                    <p className="text-xs text-text-muted truncate">
                      {user?.email}
                    </p>
                  </div>

                  {/* Menu items */}
                  <div className="py-1">
                    <button
                      onClick={() => {
                        setUserMenuOpen(false);
                        router.push('/settings');
                      }}
                      className="flex w-full items-center gap-2 px-4 py-2 text-sm text-text-secondary hover:bg-bg-2 hover:text-text-primary"
                    >
                      <Settings className="h-4 w-4" />
                      Settings
                    </button>
                    <button
                      onClick={handleLogout}
                      className="flex w-full items-center gap-2 px-4 py-2 text-sm text-error hover:bg-error/10"
                    >
                      <LogOut className="h-4 w-4" />
                      Log out
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </header>

      {/* Command Menu */}
      <CommandMenu open={commandMenuOpen} onOpenChange={setCommandMenuOpen} />
    </>
  );
}
