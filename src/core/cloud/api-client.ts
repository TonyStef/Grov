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
  ReasoningTraceEntry,
  RecordInjectionRequest,
  RecordInjectionResponse,
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

// Security limits for API params
const MAX_CONTEXT_LENGTH = 2000;  // Max chars for semantic search context
const MAX_FILES_COUNT = 20;       // Max files for boost/filter

/**
 * Fetch team memories from cloud (Supabase via API)
 * Cloud equivalent of getTasksForProject() from store.ts
 * Supports hybrid search when context is provided
 *
 * @param teamId - Team UUID
 * @param projectPath - Project path to filter by (exact match)
 * @param options - Optional filters (files, status, limit, context, current_files)
 * @returns Array of memories (empty array on error - fail silent)
 */
export async function fetchTeamMemories(
  teamId: string,
  projectPath: string,
  options?: {
    files?: string[];
    status?: string;
    limit?: number;
    context?: string;        // User prompt for semantic search
    current_files?: string[]; // Files for boost (1.2x multiplier)
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
    options.files.slice(0, MAX_FILES_COUNT).forEach(f => params.append('files', f));
  }

  // Hybrid search params (with security limits)
  if (options?.context) {
    params.set('context', options.context.substring(0, MAX_CONTEXT_LENGTH));
  }
  if (options?.current_files && options.current_files.length > 0) {
    // Comma-separated for current_files (boost)
    const files = options.current_files.slice(0, MAX_FILES_COUNT);
    params.set('current_files', files.join(','));
  }

  const url = `/teams/${teamId}/memories?${params.toString()}`;

  try {
    const response = await apiRequest<MemoryListResponse>('GET', url);

    if (response.error) {
      console.error(`[API-CLIENT] FAILED: ${response.error}`);
      return [];  // Fail silent - don't block Claude Code
    }

    if (!response.data || !response.data.memories) {
      return [];
    }

    // Check if blocked due to quota
    if (response.data.blocked) {
      console.log('\n[grov] \x1b[33m⚠️  Free quota exceeded (110%). Upgrade to continue using memory injection.\x1b[0m');
      console.log('[grov]    Manage plan: https://app.grov.dev/settings\n');
      return [];
    }

    return response.data.memories;

  } catch (err) {
    // const errorMsg = err instanceof Error ? err.message : 'Unknown error';
    // console.error(`[API] fetchTeamMemories exception: ${errorMsg}`);
    return [];  // Fail silent - don't block Claude Code
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
