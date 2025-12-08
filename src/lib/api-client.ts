// HTTP client for Grov API calls
// Handles authentication, retries, and error handling

import { request } from 'undici';
import { getAccessToken } from './credentials.js';
import type {
  Team,
  TeamListResponse,
  Memory,
  MemoryListResponse,
  MemorySyncRequest,
  MemorySyncResponse,
  DeviceFlowStartResponse,
  DeviceFlowPollResponse,
} from '@grov/shared';

// API configuration
const API_URL = process.env.GROV_API_URL || 'https://api.grov.dev';

// Response wrapper
export interface ApiResponse<T> {
  data?: T;
  error?: string;
  status: number;
}

/**
 * Make an authenticated API request
 */
export async function apiRequest<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
  options?: { requireAuth?: boolean }
): Promise<ApiResponse<T>> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  // Add auth header if required (default: true)
  if (options?.requireAuth !== false) {
    const token = await getAccessToken();
    if (!token) {
      return {
        error: 'Not authenticated. Please run: grov login',
        status: 401,
      };
    }
    headers['Authorization'] = `Bearer ${token}`;
  }

  try {
    const response = await request(`${API_URL}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    const responseBody = await response.body.text();

    // Handle empty responses
    if (!responseBody) {
      return {
        data: undefined,
        status: response.statusCode,
      };
    }

    const data = JSON.parse(responseBody);

    if (response.statusCode >= 400) {
      return {
        error: data.error || data.message || 'Request failed',
        status: response.statusCode,
      };
    }

    return {
      data: data as T,
      status: response.statusCode,
    };
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : 'Network error',
      status: 0,
    };
  }
}

// ============= Auth Endpoints (no auth required) =============

/**
 * Start device authorization flow
 */
export async function startDeviceFlow(): Promise<ApiResponse<DeviceFlowStartResponse>> {
  return apiRequest<DeviceFlowStartResponse>('POST', '/auth/device', {}, {
    requireAuth: false,
  });
}

/**
 * Poll for device authorization
 */
export async function pollDeviceFlow(
  deviceCode: string
): Promise<ApiResponse<DeviceFlowPollResponse>> {
  return apiRequest<DeviceFlowPollResponse>(
    'POST',
    '/auth/device/poll',
    { device_code: deviceCode },
    { requireAuth: false }
  );
}

// ============= Team Endpoints =============

/**
 * List user's teams
 */
export async function fetchTeams(): Promise<Team[]> {
  const response = await apiRequest<TeamListResponse>('GET', '/teams');

  if (response.error || !response.data) {
    throw new Error(response.error || 'Failed to fetch teams');
  }

  return response.data.teams;
}

/**
 * Get team by ID
 */
export async function fetchTeam(teamId: string): Promise<Team> {
  const response = await apiRequest<Team>('GET', `/teams/${teamId}`);

  if (response.error || !response.data) {
    throw new Error(response.error || 'Failed to fetch team');
  }

  return response.data;
}

// ============= Memory Endpoints =============

/**
 * Sync memories to team
 */
export async function syncMemories(
  teamId: string,
  request: MemorySyncRequest
): Promise<MemorySyncResponse> {
  const response = await apiRequest<MemorySyncResponse>(
    'POST',
    `/teams/${teamId}/memories/sync`,
    request
  );

  if (response.error || !response.data) {
    throw new Error(response.error || 'Failed to sync memories');
  }

  return response.data;
}

/**
 * Fetch team memories from cloud (Supabase via API)
 * Cloud equivalent of getTasksForProject() from store.ts
 *
 * @param teamId - Team UUID
 * @param projectPath - Project path to filter by (exact match)
 * @param options - Optional filters (files, status, limit)
 * @returns Array of memories (empty array on error - fail silent)
 */
export async function fetchTeamMemories(
  teamId: string,
  projectPath: string,
  options?: {
    files?: string[];
    status?: string;
    limit?: number;
  }
): Promise<Memory[]> {
  // Build query params
  const params = new URLSearchParams();
  params.set('project_path', projectPath);

  if (options?.status) {
    params.set('status', options.status);
  }
  if (options?.limit) {
    params.set('limit', options.limit.toString());
  }
  if (options?.files && options.files.length > 0) {
    // API expects multiple 'files' params for array
    options.files.forEach(f => params.append('files', f));
  }

  const url = `/teams/${teamId}/memories?${params.toString()}`;

  console.log(`[API] fetchTeamMemories: GET ${url}`);

  try {
    const response = await apiRequest<MemoryListResponse>('GET', url);

    if (response.error) {
      console.warn(`[API] fetchTeamMemories failed: ${response.error} (status: ${response.status})`);
      return [];  // Fail silent - don't block Claude Code
    }

    if (!response.data || !response.data.memories) {
      console.log('[API] fetchTeamMemories: No memories returned');
      return [];
    }

    console.log(`[API] fetchTeamMemories: Got ${response.data.memories.length} memories`);
    return response.data.memories;

  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Unknown error';
    console.error(`[API] fetchTeamMemories exception: ${errorMsg}`);
    return [];  // Fail silent - don't block Claude Code
  }
}

// ============= Utility Functions =============

/**
 * Sleep helper for polling
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Get API URL (for display)
 */
export function getApiUrl(): string {
  return API_URL;
}
