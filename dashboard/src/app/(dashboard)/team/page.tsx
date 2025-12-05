import type { Metadata } from 'next';
import { UserPlus, MoreVertical } from 'lucide-react';

export const metadata: Metadata = {
  title: 'Team',
};

export default function TeamPage() {
  return (
    <div className="animate-fade-in space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Team</h1>
          <p className="mt-1 text-text-secondary">
            Manage your team members and invitations
          </p>
        </div>
        <button className="flex items-center gap-2 rounded-md bg-accent-400 px-4 py-2 text-sm font-medium text-bg-0 transition-colors hover:bg-accent-500">
          <UserPlus className="h-4 w-4" />
          Invite Member
        </button>
      </div>

      {/* Members Table */}
      <div className="rounded-lg border border-border bg-bg-1">
        <table className="w-full">
          <thead>
            <tr className="border-b border-border text-left text-sm text-text-muted">
              <th className="px-6 py-3 font-medium">Member</th>
              <th className="px-6 py-3 font-medium">Role</th>
              <th className="px-6 py-3 font-medium">Joined</th>
              <th className="px-6 py-3 font-medium">Memories</th>
              <th className="w-12 px-6 py-3"></th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-border last:border-0">
              <td className="px-6 py-4">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-full bg-accent-400/20 font-medium text-accent-400">
                    T
                  </div>
                  <div>
                    <p className="font-medium">Tony</p>
                    <p className="text-sm text-text-muted">tony@example.com</p>
                  </div>
                </div>
              </td>
              <td className="px-6 py-4">
                <span className="rounded-full bg-accent-400/10 px-2.5 py-1 text-xs font-medium text-accent-400">
                  Owner
                </span>
              </td>
              <td className="px-6 py-4 text-text-secondary">Just now</td>
              <td className="px-6 py-4 font-mono text-text-secondary">0</td>
              <td className="px-6 py-4">
                <button className="rounded p-1 text-text-muted hover:bg-bg-2 hover:text-text-primary">
                  <MoreVertical className="h-4 w-4" />
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* Pending Invitations */}
      <div className="rounded-lg border border-border bg-bg-1 p-6">
        <h2 className="mb-4 font-medium">Pending Invitations</h2>
        <p className="text-sm text-text-muted">No pending invitations</p>
      </div>
    </div>
  );
}
