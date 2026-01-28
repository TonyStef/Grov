'use client';

import Link from 'next/link';
import Image from 'next/image';
import { usePathname } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import {
  Home,
  Brain,
  Search,
  Users,
  Settings,
  ClipboardList,
} from 'lucide-react';
import { getInitials } from '@/lib/utils';
import type { Team } from '@grov/shared';

interface NavigationItem {
  name: string;
  href: string;
  icon: typeof Home;
}

const NAVIGATION_ITEMS: NavigationItem[] = [
  { name: 'Dashboard', href: '/dashboard', icon: Home },
  { name: 'Memories', href: '/memories', icon: Brain },
  { name: 'Plans', href: '/plans', icon: ClipboardList },
  { name: 'Search', href: '/search', icon: Search },
  { name: 'Team', href: '/team', icon: Users },
  { name: 'Settings', href: '/settings', icon: Settings },
];

interface SidebarProps {
  initialTeams?: Team[];
}

const NPM_REGISTRY_URL = 'https://registry.npmjs.org/grov/latest';
const NPM_PACKAGE_URL = 'https://www.npmjs.com/package/grov';
const ONE_DAY_MS = 1000 * 60 * 60 * 24;
const ONE_WEEK_MS = ONE_DAY_MS * 7;

async function fetchLatestVersion(): Promise<string | null> {
  const response = await fetch(NPM_REGISTRY_URL);
  if (!response.ok) return null;

  const data = await response.json();
  return data.version as string;
}

function VersionFooter() {
  const { data: version } = useQuery({
    queryKey: ['npm-version', 'grov'],
    queryFn: fetchLatestVersion,
    staleTime: ONE_DAY_MS,
    gcTime: ONE_WEEK_MS,
    retry: 1,
  });

  const versionText = version ? `grov v${version}` : 'grov';

  return (
    <a
      href={NPM_PACKAGE_URL}
      target="_blank"
      rel="noopener noreferrer"
      className="block rounded-lg bg-bark border border-border p-2 transition-all hover:border-leaf/30 hover:bg-moss"
    >
      <p className="text-[10px] text-text-quiet">Latest version</p>
      <p className="font-mono text-[10px] text-leaf">{versionText}</p>
    </a>
  );
}

export function Sidebar({ initialTeams }: SidebarProps) {
  const pathname = usePathname();
  const currentTeam = initialTeams?.[0];

  return (
    <aside className="sticky top-0 flex h-screen w-56 flex-col border-r border-border bg-root">
      <div className="p-4">
        <Link href="/dashboard" className="inline-flex items-center gap-2">
          <Image
            src="/owl-logo.png"
            alt="Grov"
            width={48}
            height={48}
            priority
            className="object-contain"
          />
          <span className="font-sans text-base font-semibold text-text-bright">grov</span>
        </Link>
      </div>

      <div className="px-3 pb-3">
        <div className="flex items-center gap-2 rounded-lg bg-bark border border-border px-2.5 py-2 text-xs">
          <div className="flex h-5 w-5 items-center justify-center rounded bg-leaf/10 text-[10px] font-medium text-leaf">
            {currentTeam ? getInitials(currentTeam.name) : '?'}
          </div>
          <span className="truncate max-w-[120px] text-text-bright">
            {currentTeam?.name || 'No Team'}
          </span>
        </div>
      </div>

      <nav className="flex-1 space-y-0.5 px-2">
        {NAVIGATION_ITEMS.map((item) => {
          const isActive = pathname === item.href || pathname.startsWith(item.href + '/');
          const linkClassName = isActive
            ? 'bg-leaf/10 text-leaf'
            : 'text-text-calm hover:bg-bark hover:text-text-bright';
          const iconClassName = isActive
            ? 'text-leaf'
            : 'text-text-quiet group-hover:text-text-calm';

          return (
            <Link
              key={item.name}
              href={item.href}
              className={`group relative flex items-center gap-2.5 rounded-lg px-3 py-2 text-xs font-medium transition-all ${linkClassName}`}
            >
              {isActive && (
                <div className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-4 rounded-full bg-leaf" />
              )}
              <item.icon className={`h-4 w-4 ${iconClassName}`} />
              {item.name}
            </Link>
          );
        })}
      </nav>

      <div className="p-3 border-t border-border/50">
        <VersionFooter />
      </div>
    </aside>
  );
}
