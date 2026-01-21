'use server';

import { getAuthSession } from '@/lib/auth';
import { revalidatePath } from 'next/cache';

const API_URL = process.env.API_URL || 'http://localhost:3001';

interface ActionResult {
  error?: string;
  success?: boolean;
}

export async function createBranch(
  teamId: string,
  name: string
): Promise<ActionResult> {
  const auth = await getAuthSession();
  if (!auth) {
    return { error: 'You must be logged in' };
  }

  const response = await fetch(`${API_URL}/teams/${teamId}/branches`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${auth.accessToken}`,
    },
    body: JSON.stringify({ name }),
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    return { error: data.error || 'Failed to create branch' };
  }

  revalidatePath('/memories');
  return { success: true };
}

export async function setActiveBranch(
  teamId: string,
  branchName: string
): Promise<ActionResult> {
  const auth = await getAuthSession();
  if (!auth) {
    return { error: 'You must be logged in' };
  }

  const response = await fetch(`${API_URL}/teams/${teamId}/active-branch`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${auth.accessToken}`,
    },
    body: JSON.stringify({ branch: branchName }),
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    return { error: data.error || 'Failed to switch branch' };
  }

  revalidatePath('/memories');
  return { success: true };
}

export async function mergeBranch(
  teamId: string,
  branchName: string
): Promise<ActionResult> {
  const auth = await getAuthSession();
  if (!auth) {
    return { error: 'You must be logged in' };
  }

  const response = await fetch(
    `${API_URL}/teams/${teamId}/branches/${encodeURIComponent(branchName)}/merge`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${auth.accessToken}`,
      },
    }
  );

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    return { error: data.error || 'Failed to merge branch' };
  }

  revalidatePath('/memories');
  return { success: true };
}

export async function unmergeBranch(
  teamId: string,
  branchName: string
): Promise<ActionResult> {
  const auth = await getAuthSession();
  if (!auth) {
    return { error: 'You must be logged in' };
  }

  const response = await fetch(
    `${API_URL}/teams/${teamId}/branches/${encodeURIComponent(branchName)}/unmerge`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${auth.accessToken}`,
      },
    }
  );

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    return { error: data.error || 'Failed to unmerge branch' };
  }

  revalidatePath('/memories');
  return { success: true };
}

export async function discardBranch(
  teamId: string,
  branchName: string
): Promise<ActionResult> {
  const auth = await getAuthSession();
  if (!auth) {
    return { error: 'You must be logged in' };
  }

  const response = await fetch(
    `${API_URL}/teams/${teamId}/branches/${encodeURIComponent(branchName)}`,
    {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${auth.accessToken}`,
      },
    }
  );

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    return { error: data.error || 'Failed to discard branch' };
  }

  revalidatePath('/memories');
  return { success: true };
}

export async function inviteToBranch(
  teamId: string,
  branchName: string,
  userId: string
): Promise<ActionResult> {
  const auth = await getAuthSession();
  if (!auth) {
    return { error: 'You must be logged in' };
  }

  const response = await fetch(
    `${API_URL}/teams/${teamId}/branches/${encodeURIComponent(branchName)}/members`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${auth.accessToken}`,
      },
      body: JSON.stringify({ user_id: userId }),
    }
  );

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    return { error: data.error || 'Failed to add member to branch' };
  }

  revalidatePath('/memories');
  return { success: true };
}

interface BranchMember {
  user_id: string;
  email: string;
  full_name: string | null;
  avatar_url: string | null;
  role: string;
}

export async function getBranchMembersAction(
  teamId: string,
  branchName: string
): Promise<{ members: BranchMember[]; error?: string }> {
  const auth = await getAuthSession();
  if (!auth) {
    return { members: [], error: 'You must be logged in' };
  }

  const response = await fetch(
    `${API_URL}/teams/${teamId}/branches/${encodeURIComponent(branchName)}/members`,
    {
      headers: {
        Authorization: `Bearer ${auth.accessToken}`,
      },
    }
  );

  if (!response.ok) {
    return { members: [] };
  }

  const data = await response.json();
  return { members: data.members };
}

export async function removeFromBranch(
  teamId: string,
  branchName: string,
  userId: string
): Promise<ActionResult> {
  const auth = await getAuthSession();
  if (!auth) {
    return { error: 'You must be logged in' };
  }

  const response = await fetch(
    `${API_URL}/teams/${teamId}/branches/${encodeURIComponent(branchName)}/members/${userId}`,
    {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${auth.accessToken}`,
      },
    }
  );

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    return { error: data.error || 'Failed to remove member from branch' };
  }

  revalidatePath('/memories');
  return { success: true };
}
