'use client';

import Image from 'next/image';
import { Shield, Crown, User } from 'lucide-react';
import { formatRelativeDate, getInitials } from '@/lib/utils';
import type { TeamMemberWithProfile } from '@/lib/queries/teams';
import { MemberActionsMenu } from './member-actions-menu';

interface TeamMembersTableProps {
  members: TeamMemberWithProfile[];
  currentUserId: string;
  userRole: string | null;
  onRemoveMember: (userId: string) => void;
  onChangeRole: (userId: string, role: 'admin' | 'member') => void;
}

const roleConfig = {
  owner: {
    label: 'Owner',
    icon: Crown,
    className: 'bg-yellow-400/10 text-yellow-400',
  },
  admin: {
    label: 'Admin',
    icon: Shield,
    className: 'bg-accent-400/10 text-accent-400',
  },
  member: {
    label: 'Member',
    icon: User,
    className: 'bg-bg-2 text-text-secondary',
  },
};

export function TeamMembersTable({
  members,
  currentUserId,
  userRole,
  onRemoveMember,
  onChangeRole,
}: TeamMembersTableProps) {
  const canManageMembers = userRole === 'owner' || userRole === 'admin';

  return (
    <div className="rounded-lg border border-border bg-bg-1">
      <table className="w-full">
        <thead>
          <tr className="border-b border-border text-left text-sm text-text-muted">
            <th className="px-6 py-3 font-medium">Member</th>
            <th className="px-6 py-3 font-medium">Role</th>
            <th className="px-6 py-3 font-medium">Joined</th>
            {canManageMembers && <th className="w-12 px-6 py-3"></th>}
          </tr>
        </thead>
        <tbody>
          {members.map((member) => {
            const role = roleConfig[member.role as keyof typeof roleConfig] || roleConfig.member;
            const isCurrentUser = member.user_id === currentUserId;
            const canRemove = canManageMembers && !isCurrentUser && member.role !== 'owner';

            return (
              <tr
                key={member.user_id}
                className="border-b border-border last:border-0"
              >
                <td className="px-6 py-4">
                  <div className="flex items-center gap-3">
                    {member.avatar_url ? (
                      <Image
                        src={member.avatar_url}
                        alt={member.full_name || member.email}
                        width={40}
                        height={40}
                        className="rounded-full"
                      />
                    ) : (
                      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-accent-400/20 font-medium text-accent-400">
                        {getInitials(member.full_name || member.email)}
                      </div>
                    )}
                    <div>
                      <p className="font-medium">
                        {member.full_name || 'Unknown'}
                        {isCurrentUser && (
                          <span className="ml-2 text-xs text-text-muted">(you)</span>
                        )}
                      </p>
                      <p className="text-sm text-text-muted">{member.email}</p>
                    </div>
                  </div>
                </td>
                <td className="px-6 py-4">
                  <span
                    className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${role.className}`}
                  >
                    <role.icon className="h-3 w-3" />
                    {role.label}
                  </span>
                </td>
                <td className="px-6 py-4 text-text-secondary">
                  {formatRelativeDate(member.joined_at)}
                </td>
                {canManageMembers && (
                  <td className="px-6 py-4">
                    {canRemove && (
                      <MemberActionsMenu
                        memberRole={member.role}
                        isOwner={userRole === 'owner'}
                        onChangeRole={(role) => onChangeRole(member.user_id, role)}
                        onRemove={() => onRemoveMember(member.user_id)}
                      />
                    )}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
