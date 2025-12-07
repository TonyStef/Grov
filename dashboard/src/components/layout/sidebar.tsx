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
      className="block rounded-md bg-bg-2 p-3 transition-colors hover:bg-bg-3"
    >
      <p className="text-xs text-text-muted">Latest version</p>
      <p className="font-mono text-xs text-accent-400">
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
      <div className="relative border-b border-border p-4">
        <button
          onClick={() => setIsTeamMenuOpen(!isTeamMenuOpen)}
          className="flex w-full items-center justify-between rounded-md bg-bg-2 px-3 py-2 text-sm transition-colors hover:bg-bg-3"
        >
          <div className="flex items-center gap-2">
            <div className="flex h-6 w-6 items-center justify-center rounded bg-accent-400/20 text-xs font-medium text-accent-400">
              {currentTeam ? getInitials(currentTeam.name) : '?'}
            </div>
            <span className="truncate max-w-[140px]">
              {currentTeam?.name || 'No Team'}
            </span>
          </div>
          <ChevronDown
            className={`h-4 w-4 text-text-muted transition-transform ${
              isTeamMenuOpen ? 'rotate-180' : ''
            }`}
          />
        </button>

        {/* Team Dropdown */}
        {isTeamMenuOpen && (
          <>
            {/* Backdrop */}
            <div
              className="fixed inset-0 z-10"
              onClick={() => setIsTeamMenuOpen(false)}
            />

            {/* Menu */}
            <div className="absolute left-4 right-4 top-full z-20 mt-1 rounded-md border border-border bg-bg-1 py-1 shadow-lg">
              {teams.length === 0 ? (
                <div className="px-3 py-2 text-sm text-text-muted">
                  No teams yet
                </div>
              ) : (
                teams.map((team) => (
                  <button
                    key={team.id}
                    onClick={() => handleTeamSelect(team.id)}
                    className="flex w-full items-center justify-between px-3 py-2 text-sm hover:bg-bg-2"
                  >
                    <div className="flex items-center gap-2">
                      <div className="flex h-5 w-5 items-center justify-center rounded bg-accent-400/20 text-xs font-medium text-accent-400">
                        {getInitials(team.name)}
                      </div>
                      <span className="truncate">{team.name}</span>
                    </div>
                    {team.id === currentTeam?.id && (
                      <Check className="h-4 w-4 text-accent-400" />
                    )}
                  </button>
                ))
              )}

              {/* Create new team link */}
              <div className="border-t border-border mt-1 pt-1">
                <Link
                  href="/team"
                  onClick={() => setIsTeamMenuOpen(false)}
                  className="flex w-full items-center gap-2 px-3 py-2 text-sm text-text-secondary hover:bg-bg-2 hover:text-text-primary"
                >
                  <Plus className="h-4 w-4" />
                  Create new team
                </Link>
              </div>
            </div>
          </>
        )}
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
        <VersionFooter />
      </div>
    </aside>
  );
}
