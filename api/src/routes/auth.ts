// Authentication routes for device authorization flow
// Handles CLI authentication via OAuth-like device flow

import type { FastifyInstance } from 'fastify';
import type {
  DeviceFlowStartResponse,
  DeviceFlowPollRequest,
  DeviceFlowPollResponse,
  DeviceAuthorizeRequest,
  DeviceAuthorizeResponse,
  TokenRefreshRequest,
  TokenRefreshResponse,
} from '@grov/shared';
import { supabase } from '../db/client.js';
import { randomBytes } from 'crypto';
import { generateTokenPair, verifyToken } from '../lib/jwt.js';
import { getUserTeams } from '../middleware/team.js';

// Generate random code (uppercase alphanumeric)
function generateCode(length: number): string {
  return randomBytes(length)
    .toString('base64')
    .replace(/[^A-Z0-9]/gi, '')
    .substring(0, length)
    .toUpperCase();
}

// Rate limit configurations for auth endpoints
const authRateLimits = {
  deviceStart: { max: 5, timeWindow: '1 minute' },    // 5 device flows per minute
  devicePoll: { max: 15, timeWindow: '1 minute' },    // 15 polls per minute (every 4 seconds)
  deviceCheck: { max: 10, timeWindow: '1 minute' },   // 10 code checks per minute
  deviceAuthorize: { max: 5, timeWindow: '1 minute' }, // 5 authorizations per minute
  tokenRefresh: { max: 10, timeWindow: '1 minute' },  // 10 refreshes per minute
};

export default async function authRoutes(fastify: FastifyInstance) {
  // Start device flow - CLI calls this to get codes
  fastify.post<{ Reply: DeviceFlowStartResponse }>(
    '/device',
    { config: { rateLimit: authRateLimits.deviceStart } },
    async (request, reply) => {
      const deviceCode = generateCode(32);
      const userCode = `${generateCode(4)}-${generateCode(4)}`;
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

      const { error } = await supabase.from('device_codes').insert({
        device_code: deviceCode,
        user_code: userCode,
        expires_at: expiresAt.toISOString(),
      });

      if (error) {
        fastify.log.error(error);
        return reply.status(500).send({ error: 'Failed to create device code' } as any);
      }

      return {
        device_code: deviceCode,
        user_code: userCode,
        verification_uri: `${process.env.DASHBOARD_URL || 'http://localhost:3000'}/device`,
        expires_in: 900, // 15 minutes in seconds
        interval: 5, // Poll every 5 seconds
      };
    }
  );

  // Poll for token - CLI calls this repeatedly until authorized
  fastify.post<{ Body: DeviceFlowPollRequest; Reply: DeviceFlowPollResponse }>(
    '/device/poll',
    { config: { rateLimit: authRateLimits.devicePoll } },
    async (request, reply) => {
      const { device_code } = request.body;

      if (!device_code) {
        return reply.status(400).send({ error: 'device_code is required' } as any);
      }

      // Get device code record
      const { data, error } = await supabase
        .from('device_codes')
        .select('*')
        .eq('device_code', device_code)
        .single();

      if (error || !data) {
        return { status: 'expired' };
      }

      // Check if expired
      if (new Date(data.expires_at) < new Date()) {
        // Clean up expired code
        await supabase.from('device_codes').delete().eq('device_code', device_code);
        return { status: 'expired' };
      }

      // Check if authorized
      if (!data.authorized || !data.user_id) {
        return { status: 'pending' };
      }

      // Device is authorized - get user info and generate tokens
      const { data: profile, error: profileError } = await supabase
        .from('profiles')
        .select('id, email')
        .eq('id', data.user_id)
        .single();

      if (profileError || !profile) {
        fastify.log.error(profileError);
        return reply.status(500).send({ error: 'Failed to get user profile' } as any);
      }

      // Get user's teams for JWT cache
      const teams = await getUserTeams(profile.id);

      // Generate real JWT tokens
      const tokens = await generateTokenPair({
        sub: profile.id,
        email: profile.email,
        teams,
      });

      // Delete the device code after successful token generation
      await supabase.from('device_codes').delete().eq('device_code', device_code);

      return {
        status: 'authorized',
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: tokens.expires_at,
      };
    }
  );

  // Get device code info - Dashboard calls this to verify code
  fastify.get<{ Params: { code: string } }>(
    '/device/:code',
    { config: { rateLimit: authRateLimits.deviceCheck } },
    async (request, reply) => {
      const { code } = request.params;

      const { data, error } = await supabase
        .from('device_codes')
        .select('user_code, expires_at, authorized')
        .eq('user_code', code.toUpperCase())
        .single();

      if (error || !data) {
        return reply.status(404).send({ error: 'Device code not found' });
      }

      if (new Date(data.expires_at) < new Date()) {
        return reply.status(410).send({ error: 'Device code expired' });
      }

      return {
        user_code: data.user_code,
        expires_at: data.expires_at,
        authorized: data.authorized,
      };
    }
  );

  // Authorize device - Dashboard calls this when user approves
  // Requires Supabase access token in Authorization header for security
  fastify.post<{ Params: { code: string }; Body: DeviceAuthorizeRequest; Reply: DeviceAuthorizeResponse }>(
    '/device/:code',
    { config: { rateLimit: authRateLimits.deviceAuthorize } },
    async (request, reply) => {
      const { code } = request.params;
      const { user_code } = request.body;

      // Extract and verify Supabase access token from Authorization header
      const authHeader = request.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return { success: false, error: 'Authentication required. Please log in to the dashboard first.' };
      }

      const supabaseToken = authHeader.slice(7); // Remove 'Bearer ' prefix

      // Verify token with Supabase to get the actual user
      const { data: { user: supabaseUser }, error: authError } = await supabase.auth.getUser(supabaseToken);

      if (authError || !supabaseUser) {
        fastify.log.warn('Invalid Supabase token for device authorization');
        return { success: false, error: 'Invalid or expired session. Please log in again.' };
      }

      const userId = supabaseUser.id;
      const userEmail = supabaseUser.email;

      if (!userId || !userEmail) {
        return { success: false, error: 'Unable to verify user identity.' };
      }

      // Verify the user code matches
      if (code.toUpperCase() !== user_code.toUpperCase()) {
        return { success: false, error: 'Invalid user code' };
      }

      // Check if device code exists and is not expired
      const { data: deviceCode, error: checkError } = await supabase
        .from('device_codes')
        .select('*')
        .eq('user_code', code.toUpperCase())
        .single();

      if (checkError || !deviceCode) {
        return { success: false, error: 'Device code not found' };
      }

      if (new Date(deviceCode.expires_at) < new Date()) {
        return { success: false, error: 'Device code has expired. Please run grov login again.' };
      }

      if (deviceCode.authorized) {
        return { success: false, error: 'Device already authorized' };
      }

      // Authorize the device
      const { error } = await supabase
        .from('device_codes')
        .update({ authorized: true, user_id: userId })
        .eq('user_code', code.toUpperCase());

      if (error) {
        fastify.log.error(error);
        return { success: false, error: 'Failed to authorize device' };
      }

      fastify.log.info(`Device authorized for user ${userEmail}`);
      return { success: true };
    }
  );

  // Refresh token - CLI calls this to get new access token
  fastify.post<{ Body: TokenRefreshRequest; Reply: TokenRefreshResponse }>(
    '/refresh',
    { config: { rateLimit: authRateLimits.tokenRefresh } },
    async (request, reply) => {
      const { refresh_token } = request.body;

      if (!refresh_token) {
        return reply.status(400).send({ error: 'refresh_token is required' } as any);
      }

      try {
        // Verify the refresh token
        const payload = await verifyToken(refresh_token);

        if (payload.type !== 'refresh') {
          return reply.status(401).send({ error: 'Invalid token type' } as any);
        }

        // Get user's current teams (may have changed since original token)
        const teams = await getUserTeams(payload.sub);

        // Generate new token pair
        const tokens = await generateTokenPair({
          sub: payload.sub,
          email: payload.email,
          teams,
        });

        return {
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          expires_at: tokens.expires_at,
        };
      } catch {
        return reply.status(401).send({ error: 'Invalid or expired refresh token' } as any);
      }
    }
  );
}
