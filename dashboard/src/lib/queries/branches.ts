import { cache } from 'react';
import { getAuthSession } from '@/lib/auth';

const API_URL = process.env.API_URL || 'http://localhost:3001';

export interface Branch {
  name: string;
  status: string;
  implicit?: boolean;
  id?: string;
  created_by?: string;
  created_at?: string;
  merged_at?: string | null;
  merged_by?: string | null;
  member_count?: number;
}

export interface BranchMember {
  user_id: string;
  email: string;
  full_name: string | null;
  avatar_url: string | null;
  role: string;
}

export const getTeamBranches = cache(async (teamId: string): Promise<Branch[]> => {
  const auth = await getAuthSession();
  if (!auth) return [];

  const response = await fetch(`${API_URL}/teams/${teamId}/branches`, {
    headers: {
      Authorization: `Bearer ${auth.accessToken}`,
    },
    next: { revalidate: 30 },
  });

  if (!response.ok) return [];

  const data = await response.json();
  return data.branches;
});

export const getBranchMembers = cache(async (
  teamId: string,
  branchName: string
): Promise<BranchMember[]> => {
  const auth = await getAuthSession();
  if (!auth) return [];

  const response = await fetch(
    `${API_URL}/teams/${teamId}/branches/${encodeURIComponent(branchName)}/members`,
    {
      headers: {
        Authorization: `Bearer ${auth.accessToken}`,
      },
      next: { revalidate: 30 },
    }
  );

  if (!response.ok) return [];

  const data = await response.json();
  return data.members;
});
