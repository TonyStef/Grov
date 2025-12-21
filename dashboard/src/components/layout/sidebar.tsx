'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Home,
  Brain,
  Search,
  Users,
  Settings,
  ChevronDown,
  Check,
  Plus,
} from 'lucide-react';
import { useTeamStore, useCurrentTeam, useTeams } from '@/stores/team-store';
import { getInitials } from '@/lib/utils';
import type { Team } from '@grov/shared';

const navigation = [
  { name: 'Dashboard', href: '/dashboard', icon: Home },
  { name: 'Memories', href: '/memories', icon: Brain },
  { name: 'Search', href: '/search', icon: Search },
  { name: 'Team', href: '/team', icon: Users },
  { name: 'Settings', href: '/settings', icon: Settings },
];

interface SidebarProps {
  initialTeams?: Team[];
}

function VersionFooter() {
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    fetch('https://registry.npmjs.org/grov/latest')
      .then((res) => res.json())
      .then((data) => setVersion(data.version))
      .catch(() => setVersion(null));
  }, []);

  return (
    <a
      href="https://www.npmjs.com/package/grov"
      target="_blank"
      rel="noopener noreferrer"
      className="block rounded-lg bg-bark border border-border p-2 transition-all hover:border-leaf/30 hover:bg-moss"
    >
      <p className="text-[10px] text-text-quiet">Latest version</p>
      <p className="font-mono text-[10px] text-leaf">
        {version ? `grov v${version}` : 'grov'}
      </p>
    </a>
  );
}

export function Sidebar({ initialTeams }: SidebarProps) {
  const pathname = usePathname();
  const [isTeamMenuOpen, setIsTeamMenuOpen] = useState(false);

  const currentTeam = useCurrentTeam();
  const teams = useTeams();
  const setTeams = useTeamStore((state) => state.setTeams);
  const setCurrentTeam = useTeamStore((state) => state.setCurrentTeam);

  // Initialize teams from server data
  useEffect(() => {
    if (initialTeams && initialTeams.length > 0) {
      setTeams(initialTeams);
    }
  }, [initialTeams, setTeams]);

  const handleTeamSelect = (teamId: string) => {
    setCurrentTeam(teamId);
    setIsTeamMenuOpen(false);
    // Refresh the page to load new team data
    window.location.reload();
  };

  return (
    <aside className="sticky top-0 flex h-screen w-56 flex-col border-r border-border bg-root">
      <div className="p-4">
        <Link href="/dashboard" className="inline-flex items-center gap-2">
          <img
            src="/grov-nobg.png"
            alt="Grov"
            className="h-7 w-7 rounded-lg object-contain"
          />
          <span className="font-sans text-base font-semibold text-text-bright">grov</span>
        </Link>
      </div>

      <div className="relative px-3 pb-3">
        <button
          onClick={() => setIsTeamMenuOpen(!isTeamMenuOpen)}
          className="flex w-full items-center justify-between rounded-lg bg-bark border border-border px-2.5 py-2 text-xs transition-all hover:border-leaf/30 hover:bg-moss"
        >
          <div className="flex items-center gap-2">
            <div className="flex h-5 w-5 items-center justify-center rounded bg-leaf/10 text-[10px] font-medium text-leaf">
              {currentTeam ? getInitials(currentTeam.name) : '?'}
            </div>
            <span className="truncate max-w-[100px] text-text-bright">
              {currentTeam?.name || 'No Team'}
            </span>
          </div>
          <ChevronDown
            className={`h-3 w-3 text-text-quiet transition-transform ${
              isTeamMenuOpen ? 'rotate-180' : ''
            }`}
          />
        </button>

        {isTeamMenuOpen && (
          <>
            <div
              className="fixed inset-0 z-10"
              onClick={() => setIsTeamMenuOpen(false)}
            />

            <div className="absolute left-3 right-3 top-full z-20 mt-1 rounded-lg border border-border bg-root py-1 shadow-lg">
              {teams.length === 0 ? (
                <div className="px-2.5 py-1.5 text-xs text-text-quiet">
                  No teams yet
                </div>
              ) : (
                teams.map((team) => (
                  <button
                    key={team.id}
                    onClick={() => handleTeamSelect(team.id)}
                    className="flex w-full items-center justify-between px-2.5 py-1.5 text-xs hover:bg-bark transition-colors"
                  >
                    <div className="flex items-center gap-2">
                      <div className="flex h-4 w-4 items-center justify-center rounded bg-leaf/10 text-[9px] font-medium text-leaf">
                        {getInitials(team.name)}
                      </div>
                      <span className="truncate text-text-bright">{team.name}</span>
                    </div>
                    {team.id === currentTeam?.id && (
                      <Check className="h-3 w-3 text-leaf" />
                    )}
                  </button>
                ))
              )}

              <div className="border-t border-border mt-1 pt-1">
                <Link
                  href="/team"
                  onClick={() => setIsTeamMenuOpen(false)}
                  className="flex w-full items-center gap-2 px-2.5 py-1.5 text-xs text-text-calm hover:bg-bark hover:text-text-bright transition-colors"
                >
                  <Plus className="h-3 w-3" />
                  Create new team
                </Link>
              </div>
            </div>
          </>
        )}
      </div>

      <nav className="flex-1 space-y-0.5 px-2">
        {navigation.map((item) => {
          const isActive = pathname === item.href || pathname.startsWith(item.href + '/');
          return (
            <Link
              key={item.name}
              href={item.href}
              className={`group relative flex items-center gap-2.5 rounded-lg px-3 py-2 text-xs font-medium transition-all ${
                isActive
                  ? 'bg-leaf/10 text-leaf'
                  : 'text-text-calm hover:bg-bark hover:text-text-bright'
              }`}
            >
              {isActive && (
                <div className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-4 rounded-full bg-leaf" />
              )}
              <item.icon className={`h-4 w-4 ${isActive ? 'text-leaf' : 'text-text-quiet group-hover:text-text-calm'}`} />
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
