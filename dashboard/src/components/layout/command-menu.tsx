'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Command } from 'cmdk';
import {
  Home,
  Brain,
  Search,
  Users,
  Settings,
  LogOut,
  Plus,
} from 'lucide-react';

interface CommandMenuProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CommandMenu({ open, onOpenChange }: CommandMenuProps) {
  const router = useRouter();

  // Handle keyboard shortcut
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        onOpenChange(!open);
      }
    };

    document.addEventListener('keydown', down);
    return () => document.removeEventListener('keydown', down);
  }, [open, onOpenChange]);

  const runCommand = (command: () => void) => {
    onOpenChange(false);
    command();
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-bg-0/80 backdrop-blur-sm"
        onClick={() => onOpenChange(false)}
      />

      {/* Command Dialog */}
      <div className="absolute left-1/2 top-[20%] w-full max-w-lg -translate-x-1/2">
        <Command className="overflow-hidden rounded-lg border border-border bg-bg-1 shadow-lg">
          <div className="flex items-center border-b border-border px-4">
            <Search className="mr-2 h-4 w-4 text-text-muted" />
            <Command.Input
              placeholder="Type a command or search..."
              className="h-12 w-full bg-transparent text-sm outline-none placeholder:text-text-muted"
              autoFocus
            />
          </div>

          <Command.List className="max-h-80 overflow-y-auto p-2">
            <Command.Empty className="py-6 text-center text-sm text-text-muted">
              No results found.
            </Command.Empty>

            <Command.Group heading="Navigation" className="px-2 py-1.5 text-xs font-medium text-text-muted">
              <CommandItem
                onSelect={() => runCommand(() => router.push('/dashboard'))}
              >
                <Home className="mr-2 h-4 w-4" />
                Dashboard
              </CommandItem>
              <CommandItem
                onSelect={() => runCommand(() => router.push('/memories'))}
              >
                <Brain className="mr-2 h-4 w-4" />
                Memories
              </CommandItem>
              <CommandItem
                onSelect={() => runCommand(() => router.push('/search'))}
              >
                <Search className="mr-2 h-4 w-4" />
                Search
              </CommandItem>
              <CommandItem
                onSelect={() => runCommand(() => router.push('/team'))}
              >
                <Users className="mr-2 h-4 w-4" />
                Team
              </CommandItem>
              <CommandItem
                onSelect={() => runCommand(() => router.push('/settings'))}
              >
                <Settings className="mr-2 h-4 w-4" />
                Settings
              </CommandItem>
            </Command.Group>

            <Command.Separator className="my-2 h-px bg-border" />

            <Command.Group heading="Actions" className="px-2 py-1.5 text-xs font-medium text-text-muted">
              <CommandItem onSelect={() => runCommand(() => router.push('/team/invite'))}>
                <Plus className="mr-2 h-4 w-4" />
                Invite team member
              </CommandItem>
              <CommandItem
                onSelect={() => runCommand(() => {
                  // TODO: Sign out
                })}
              >
                <LogOut className="mr-2 h-4 w-4" />
                Sign out
              </CommandItem>
            </Command.Group>
          </Command.List>
        </Command>
      </div>
    </div>
  );
}

function CommandItem({
  children,
  onSelect,
}: {
  children: React.ReactNode;
  onSelect: () => void;
}) {
  return (
    <Command.Item
      onSelect={onSelect}
      className="flex cursor-pointer items-center rounded-md px-2 py-2 text-sm text-text-secondary outline-none data-[selected=true]:bg-bg-2 data-[selected=true]:text-text-primary"
    >
      {children}
    </Command.Item>
  );
}
