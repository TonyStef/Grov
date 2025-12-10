'use client';

import { useEffect, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Command } from 'cmdk';
import {
  Home,
  Brain,
  Search,
  Users,
  Settings,
  LogOut,
} from 'lucide-react';

interface CommandMenuProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSignOut: () => void;
}

const navigation = [
  { name: 'Dashboard', href: '/dashboard', icon: Home, shortcut: 'G D' },
  { name: 'Memories', href: '/memories', icon: Brain, shortcut: 'G M' },
  { name: 'Search', href: '/search', icon: Search, shortcut: '/' },
  { name: 'Team', href: '/team', icon: Users, shortcut: 'G T' },
  { name: 'Settings', href: '/settings', icon: Settings, shortcut: 'G S' },
];

export function CommandMenu({ open, onOpenChange, onSignOut }: CommandMenuProps) {
  const router = useRouter();
  const pendingKeyRef = useRef<string | null>(null);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);

  const navigate = useCallback((href: string) => {
    onOpenChange(false);
    router.push(href);
  }, [onOpenChange, router]);

  const handleSignOut = useCallback(() => {
    onOpenChange(false);
    onSignOut();
  }, [onOpenChange, onSignOut]);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const isInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;

      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        onOpenChange(!open);
        return;
      }

      if (e.key === 'Escape' && open) {
        e.preventDefault();
        onOpenChange(false);
        return;
      }

      if (isInput || open) return;

      if (e.key === '/' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        navigate('/search');
        return;
      }

      if (e.key.toLowerCase() === 'g' && !e.metaKey && !e.ctrlKey) {
        pendingKeyRef.current = 'g';
        if (timeoutRef.current) clearTimeout(timeoutRef.current);
        timeoutRef.current = setTimeout(() => {
          pendingKeyRef.current = null;
        }, 300);
        return;
      }

      if (pendingKeyRef.current === 'g' && !e.metaKey && !e.ctrlKey) {
        const key = e.key.toLowerCase();
        const routes: Record<string, string> = {
          d: '/dashboard',
          m: '/memories',
          t: '/team',
          s: '/settings',
        };

        if (routes[key]) {
          e.preventDefault();
          pendingKeyRef.current = null;
          if (timeoutRef.current) clearTimeout(timeoutRef.current);
          navigate(routes[key]);
        }
      }
    };

    document.addEventListener('keydown', down);
    return () => {
      document.removeEventListener('keydown', down);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [open, onOpenChange, navigate]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50">
      <div
        className="absolute inset-0 bg-bg-0/80 backdrop-blur-sm"
        onClick={() => onOpenChange(false)}
      />

      <div className="absolute left-1/2 top-[20%] w-full max-w-lg -translate-x-1/2 px-4">
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
              {navigation.map((item) => (
                <CommandItem
                  key={item.href}
                  onSelect={() => navigate(item.href)}
                  shortcut={item.shortcut}
                >
                  <item.icon className="mr-2 h-4 w-4" />
                  {item.name}
                </CommandItem>
              ))}
            </Command.Group>

            <Command.Separator className="my-2 h-px bg-border" />

            <Command.Group heading="Actions" className="px-2 py-1.5 text-xs font-medium text-text-muted">
              <CommandItem onSelect={handleSignOut}>
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
  shortcut,
}: {
  children: React.ReactNode;
  onSelect: () => void;
  shortcut?: string;
}) {
  return (
    <Command.Item
      onSelect={onSelect}
      className="flex cursor-pointer items-center rounded-md px-2 py-2 text-sm text-text-secondary outline-none data-[selected=true]:bg-bg-2 data-[selected=true]:text-text-primary"
    >
      <span className="flex flex-1 items-center">{children}</span>
      {shortcut && (
        <kbd className="ml-auto flex items-center gap-1 rounded bg-bg-3 px-1.5 py-0.5 font-mono text-xs text-text-muted">
          {shortcut}
        </kbd>
      )}
    </Command.Item>
  );
}
