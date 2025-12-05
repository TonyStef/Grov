'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Home,
  Brain,
  Search,
  Users,
  Settings,
  ChevronDown,
} from 'lucide-react';

const navigation = [
  { name: 'Dashboard', href: '/dashboard', icon: Home },
  { name: 'Memories', href: '/memories', icon: Brain },
  { name: 'Search', href: '/search', icon: Search },
  { name: 'Team', href: '/team', icon: Users },
  { name: 'Settings', href: '/settings', icon: Settings },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="flex w-64 flex-col border-r border-border bg-bg-1">
      {/* Logo */}
      <div className="flex h-16 items-center border-b border-border px-6">
        <Link href="/dashboard" className="flex items-center gap-2">
          <span className="font-mono text-xl font-bold text-accent-400 text-glow">
            grov
          </span>
        </Link>
      </div>

      {/* Team Switcher */}
      <div className="border-b border-border p-4">
        <button className="flex w-full items-center justify-between rounded-md bg-bg-2 px-3 py-2 text-sm transition-colors hover:bg-bg-3">
          <div className="flex items-center gap-2">
            <div className="flex h-6 w-6 items-center justify-center rounded bg-accent-400/20 text-xs font-medium text-accent-400">
              T
            </div>
            <span>My Team</span>
          </div>
          <ChevronDown className="h-4 w-4 text-text-muted" />
        </button>
      </div>

      {/* Navigation */}
      <nav className="flex-1 space-y-1 p-4">
        {navigation.map((item) => {
          const isActive = pathname === item.href || pathname.startsWith(item.href + '/');
          return (
            <Link
              key={item.name}
              href={item.href}
              className={`flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                isActive
                  ? 'bg-accent-400/10 text-accent-400'
                  : 'text-text-secondary hover:bg-bg-2 hover:text-text-primary'
              }`}
            >
              <item.icon className="h-4 w-4" />
              {item.name}
            </Link>
          );
        })}
      </nav>

      {/* Footer */}
      <div className="border-t border-border p-4">
        <div className="rounded-md bg-bg-2 p-3">
          <p className="text-xs text-text-muted">CLI connected</p>
          <p className="font-mono text-xs text-accent-400">grov v0.2.3</p>
        </div>
      </div>
    </aside>
  );
}
