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
  ReasoningTraceEntry,
  RecordInjectionRequest,
  RecordInjectionResponse,
} from '@grov/shared';

const DEFAULT_API_URL = 'https://api.grov.dev';
const API_URL = process.env.GROV_API_URL || DEFAULT_API_URL;

export interface ApiResponse<T> {
  data?: T;
  error?: string;
  status: number;
}

const HTTP_UNAUTHORIZED = 401;
const HTTP_ERROR_THRESHOLD = 400;

async function buildHeaders(requireAuth: boolean): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (requireAuth) {
    const token = await getAccessToken();
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
  }

  return headers;
}

export async function apiRequest<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
  options?: { requireAuth?: boolean }
): Promise<ApiResponse<T>> {
  const requireAuth = options?.requireAuth !== false;

  if (requireAuth) {
    const token = await getAccessToken();
    if (!token) {
      return {
        error: 'Not authenticated. Please run: grov login',
        status: HTTP_UNAUTHORIZED,
      };
    }
  }

  try {
    const headers = await buildHeaders(requireAuth);
    const response = await request(`${API_URL}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    const responseBody = await response.body.text();

    if (!responseBody) {
      return { data: undefined, status: response.statusCode };
    }

    const data = JSON.parse(responseBody);

    if (response.statusCode >= HTTP_ERROR_THRESHOLD) {
      return {
        error: data.error || data.message || 'Request failed',
        status: response.statusCode,
      };
    }

    return { data: data as T, status: response.statusCode };
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : 'Network error',
      status: 0,
    };
  }
}

export async function startDeviceFlow(): Promise<ApiResponse<DeviceFlowStartResponse>> {
  return apiRequest<DeviceFlowStartResponse>(
    'POST',
    '/auth/device',
    {},
    { requireAuth: false }
  );
}

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

export async function fetchTeams(): Promise<Team[]> {
  const response = await apiRequest<TeamListResponse>('GET', '/teams');

  if (response.error || !response.data) {
    throw new Error(response.error || 'Failed to fetch teams');
  }

  return response.data.teams;
}

export async function fetchTeam(teamId: string): Promise<Team> {
  const response = await apiRequest<Team>('GET', `/teams/${teamId}`);

  if (response.error || !response.data) {
    throw new Error(response.error || 'Failed to fetch team');
  }

  return response.data;
}

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

const MAX_CONTEXT_LENGTH = 2000;
const MAX_FILES_COUNT = 20;

function buildMemoryQueryParams(
  projectPath: string,
  options?: {
    files?: string[];
    status?: string;
    limit?: number;
    context?: string;
    current_files?: string[];
  }
): URLSearchParams {
  const params = new URLSearchParams();
  params.set('project_path', projectPath);

  if (options?.status) {
    params.set('status', options.status);
  }

  if (options?.limit) {
    params.set('limit', options.limit.toString());
  }

  if (options?.files?.length) {
    options.files.slice(0, MAX_FILES_COUNT).forEach(file => {
      params.append('files', file);
    });
  }

  if (options?.context) {
    params.set('context', options.context.substring(0, MAX_CONTEXT_LENGTH));
  }

  if (options?.current_files?.length) {
    const files = options.current_files.slice(0, MAX_FILES_COUNT);
    params.set('current_files', files.join(','));
  }

  return params;
}

export async function fetchTeamMemories(
  teamId: string,
  projectPath: string,
  options?: {
    files?: string[];
    status?: string;
    limit?: number;
    context?: string;
    current_files?: string[];
  }
): Promise<Memory[]> {
  const params = buildMemoryQueryParams(projectPath, options);
  const url = `/teams/${teamId}/memories?${params.toString()}`;

  try {
    const response = await apiRequest<MemoryListResponse>('GET', url);

    if (response.error) {
      console.error(`[API-CLIENT] FAILED: ${response.error}`);
      return [];
    }

    if (!response.data?.memories) {
      return [];
    }

    if (response.data.blocked) {
      console.log('\n[grov] \x1b[33m⚠️  Free quota exceeded (110%). Upgrade to continue using memory injection.\x1b[0m');
      console.log('[grov]    Manage plan: https://app.grov.dev/settings\n');
      return [];
    }

    return response.data.memories;
  } catch {
    return [];
  }
}

/**
 * Input data for match endpoint (memory content for embedding generation)
 */
export interface MatchInput {
  project_path: string;
  goal?: string;
  system_name?: string;  // Parent system anchor (e.g., 'Retry Queue')
  original_query: string;
  reasoning_trace?: ReasoningTraceEntry[];
  decisions?: Array<{ aspect?: string; tags?: string; choice: string; reason: string }>;
  evolution_steps?: Array<{ summary: string; date: string }>;
  task_type?: 'information' | 'planning' | 'implementation';
}

/**
 * Response type for match endpoint
 * Note: Embeddings are now chunk-based and generated in SYNC (not passed from MATCH)
 */
export interface MatchResponse {
  match: Memory | null;
  combined_score?: number;
}

/**
 * Fetch best matching memory for UPDATE decision
 * Used by CLI before sync to check if a similar memory exists
 *
 * API generates chunks for multi-vector search against stored memory chunks.
 * SYNC will regenerate chunks when saving (chunks not passed between endpoints).
 *
 * @param teamId - Team UUID
 * @param data - Memory data for chunk generation and search
 * @returns Match response with memory and score
 */
export async function fetchMatch(
  teamId: string,
  data: MatchInput
): Promise<MatchResponse> {
  const url = `/teams/${teamId}/memories/match`;

  try {
    const response = await apiRequest<MatchResponse>('POST', url, data);

    if (response.error) {
      console.error(`[MATCH-API] FAILED: ${response.error}`);
      return { match: null };
    }

    if (!response.data) {
      return { match: null };
    }

    return response.data;

  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Unknown error';
    console.error(`[MATCH-API] FAILED: ${errorMsg}`);
    return { match: null };
  }
}

// ============= Plan Endpoints =============

import type { PlanInjectionContext } from '@grov/shared';

interface PlanInjectionResponse {
  plans: PlanInjectionContext[];
}

/**
 * Fetch active plans for injection into Claude sessions
 * Returns empty array on error (fail silent like memories)
 */
export async function fetchTeamPlans(teamId: string): Promise<PlanInjectionContext[]> {
  const url = `/teams/${teamId}/plans/injection`;

  try {
    const response = await apiRequest<PlanInjectionResponse>('GET', url);

    if (response.error || !response.data) {
      return [];
    }

    return response.data.plans || [];
  } catch {
    return [];
  }
}

// ============= Usage Tracking =============

export async function reportInjection(
  event: RecordInjectionRequest
): Promise<RecordInjectionResponse | null> {
  try {
    const response = await apiRequest<RecordInjectionResponse>('POST', '/usage/injection', event);
    return response.data || null;
  } catch {
    return null;
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
