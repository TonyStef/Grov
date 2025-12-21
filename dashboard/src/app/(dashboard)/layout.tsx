import { Sidebar } from '@/components/layout/sidebar';
import { Header } from '@/components/layout/header';
import { HelpButton } from '@/components/ui/help-button';
import { getUserTeams } from '@/lib/queries/teams';
import { getCurrentUser } from '@/lib/queries/profiles';

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Fetch teams and user for layout components
  const [teams, currentUser] = await Promise.all([
    getUserTeams(),
    getCurrentUser(),
  ]);

  return (
    <div className="flex min-h-screen bg-soil">
      <Sidebar initialTeams={teams} />

      <div className="flex flex-1 flex-col">
        <Header user={currentUser} />
        <main className="flex-1 overflow-auto">{children}</main>
      </div>

      <HelpButton />
    </div>
  );
}
