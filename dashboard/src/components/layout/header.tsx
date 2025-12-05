'use client';

import { useState } from 'react';
import { Search, Command, Bell, User } from 'lucide-react';
import { CommandMenu } from './command-menu';

export function Header() {
  const [commandMenuOpen, setCommandMenuOpen] = useState(false);

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
          <button className="flex items-center gap-2 rounded-md p-2 text-text-muted transition-colors hover:bg-bg-2 hover:text-text-primary">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-bg-3">
              <User className="h-4 w-4" />
            </div>
          </button>
        </div>
      </header>

      {/* Command Menu */}
      <CommandMenu open={commandMenuOpen} onOpenChange={setCommandMenuOpen} />
    </>
  );
}
