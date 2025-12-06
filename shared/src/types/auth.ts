/**
 * Auth types - device authorization flow for CLI
 * Aligns with Supabase device_codes table
 */

// Device code record in database
export interface DeviceCode {
  id: string;
  device_code: string;
  user_code: string;
  user_id: string | null;
  authorized: boolean;
  expires_at: string;
  created_at: string;
}

// Response when starting device flow
export interface DeviceFlowStartResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

// Request when polling for token
export interface DeviceFlowPollRequest {
  device_code: string;
}

// Response when polling for token
export interface DeviceFlowPollResponse {
  status: 'pending' | 'authorized' | 'expired';
  access_token?: string;
  refresh_token?: string;
  expires_at?: string;
}

// Request to authorize a device (from dashboard)
export interface DeviceAuthorizeRequest {
  user_code: string;
}

// Response after authorizing a device
export interface DeviceAuthorizeResponse {
  success: boolean;
  error?: string;
}

// Token pair for CLI storage
export interface TokenPair {
  access_token: string;
  refresh_token: string;
  expires_at: string;
}

// Token refresh request
export interface TokenRefreshRequest {
  refresh_token: string;
}

// Token refresh response
export interface TokenRefreshResponse {
  access_token: string;
  refresh_token: string;
  expires_at: string;
}
