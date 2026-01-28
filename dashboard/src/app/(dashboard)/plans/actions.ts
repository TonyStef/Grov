'use server';

import { getAuthSession } from '@/lib/auth';
import { revalidatePath } from 'next/cache';
import type { CreatePlanInput, UpdatePlanInput, CreateTaskInput, UpdateTaskInput } from '@grov/shared';

const API_URL = process.env.API_URL || 'http://localhost:3001';

interface ActionResult {
  error?: string;
  success?: boolean;
  data?: unknown;
}

export async function createPlan(
  teamId: string,
  input: CreatePlanInput
): Promise<ActionResult> {
  const auth = await getAuthSession();
  if (!auth) {
    return { error: 'You must be logged in' };
  }

  const url = `${API_URL}/teams/${teamId}/plans`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${auth.accessToken}`,
      },
      body: JSON.stringify(input),
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      return { error: data.error || 'Failed to create plan' };
    }

    revalidatePath('/plans');
    return { success: true };
  } catch (err) {
    console.error('[createPlan] Fetch error:', err);
    return { error: 'Failed to connect to API' };
  }
}

export async function updatePlan(
  teamId: string,
  planId: string,
  input: UpdatePlanInput
): Promise<ActionResult> {
  const auth = await getAuthSession();
  if (!auth) {
    return { error: 'You must be logged in' };
  }

  const response = await fetch(`${API_URL}/teams/${teamId}/plans/${planId}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${auth.accessToken}`,
    },
    body: JSON.stringify(input),
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    return { error: data.error || 'Failed to update plan' };
  }

  revalidatePath('/plans');
  revalidatePath(`/plans/${planId}`);
  return { success: true };
}

export async function deletePlan(
  teamId: string,
  planId: string
): Promise<ActionResult> {
  const auth = await getAuthSession();
  if (!auth) {
    return { error: 'You must be logged in' };
  }

  const response = await fetch(`${API_URL}/teams/${teamId}/plans/${planId}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${auth.accessToken}`,
    },
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    return { error: data.error || 'Failed to delete plan' };
  }

  revalidatePath('/plans');
  return { success: true };
}

export async function createTask(
  teamId: string,
  planId: string,
  input: CreateTaskInput
): Promise<ActionResult> {
  const auth = await getAuthSession();
  if (!auth) {
    return { error: 'You must be logged in' };
  }

  const response = await fetch(`${API_URL}/teams/${teamId}/plans/${planId}/tasks`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${auth.accessToken}`,
    },
    body: JSON.stringify(input),
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    return { error: data.error || 'Failed to create task' };
  }

  revalidatePath(`/plans/${planId}`);
  return { success: true };
}

export async function updateTask(
  teamId: string,
  planId: string,
  taskId: string,
  input: UpdateTaskInput
): Promise<ActionResult> {
  const auth = await getAuthSession();
  if (!auth) {
    return { error: 'You must be logged in' };
  }

  const response = await fetch(`${API_URL}/teams/${teamId}/plans/${planId}/tasks/${taskId}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${auth.accessToken}`,
    },
    body: JSON.stringify(input),
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    return { error: data.error || 'Failed to update task' };
  }

  revalidatePath(`/plans/${planId}`);
  return { success: true };
}

export async function claimTask(
  teamId: string,
  planId: string,
  taskId: string
): Promise<ActionResult> {
  const auth = await getAuthSession();
  if (!auth) {
    return { error: 'You must be logged in' };
  }

  const response = await fetch(`${API_URL}/teams/${teamId}/plans/${planId}/tasks/${taskId}/claim`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${auth.accessToken}`,
    },
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    return { error: data.error || 'Failed to claim task' };
  }

  revalidatePath(`/plans/${planId}`);
  return { success: true };
}

export async function completeTask(
  teamId: string,
  planId: string,
  taskId: string
): Promise<ActionResult> {
  const auth = await getAuthSession();
  if (!auth) {
    return { error: 'You must be logged in' };
  }

  const response = await fetch(`${API_URL}/teams/${teamId}/plans/${planId}/tasks/${taskId}/complete`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${auth.accessToken}`,
    },
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    return { error: data.error || 'Failed to complete task' };
  }

  revalidatePath(`/plans/${planId}`);
  return { success: true };
}
