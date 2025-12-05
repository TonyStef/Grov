import type { FastifyInstance } from 'fastify';
import type {
  DeviceFlowStartResponse,
  DeviceFlowPollRequest,
  DeviceFlowPollResponse,
  DeviceAuthorizeRequest,
  DeviceAuthorizeResponse,
} from '@grov/shared';
import { supabase } from '../db/client.js';
import { randomBytes } from 'crypto';

// Generate random code
function generateCode(length: number): string {
  return randomBytes(length)
    .toString('base64')
    .replace(/[^A-Z0-9]/gi, '')
    .substring(0, length)
    .toUpperCase();
}

export default async function authRoutes(fastify: FastifyInstance) {
  // Start device flow
  fastify.post<{ Reply: DeviceFlowStartResponse }>(
    '/device',
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

  // Poll for token
  fastify.post<{ Body: DeviceFlowPollRequest; Reply: DeviceFlowPollResponse }>(
    '/device/poll',
    async (request, reply) => {
      const { device_code } = request.body;

      if (!device_code) {
        return reply.status(400).send({ error: 'device_code is required' } as any);
      }

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
        return { status: 'expired' };
      }

      // Check if authorized
      if (!data.authorized || !data.user_id) {
        return { status: 'pending' };
      }

      // Generate tokens for the user
      // In production, you'd create a proper session here
      const { data: session, error: sessionError } = await supabase.auth.admin.generateLink({
        type: 'magiclink',
        email: data.user_id, // This should be the user's email
      });

      if (sessionError) {
        fastify.log.error(sessionError);
        return reply.status(500).send({ error: 'Failed to generate token' } as any);
      }

      // Delete the device code after use
      await supabase.from('device_codes').delete().eq('device_code', device_code);

      return {
        status: 'authorized',
        access_token: 'temp_token', // TODO: Generate proper JWT
        refresh_token: 'temp_refresh',
        expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      };
    }
  );

  // Get device code info (for dashboard)
  fastify.get<{ Params: { code: string } }>(
    '/device/:code',
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

  // Authorize device (from dashboard)
  fastify.post<{ Params: { code: string }; Body: DeviceAuthorizeRequest; Reply: DeviceAuthorizeResponse }>(
    '/device/:code',
    async (request, reply) => {
      const { code } = request.params;
      const { user_code } = request.body;

      // TODO: Get current user from session
      const userId = 'temp-user-id'; // This should come from auth middleware

      // Verify the user code matches
      if (code.toUpperCase() !== user_code.toUpperCase()) {
        return { success: false, error: 'Invalid user code' };
      }

      const { error } = await supabase
        .from('device_codes')
        .update({ authorized: true, user_id: userId })
        .eq('user_code', code.toUpperCase())
        .gt('expires_at', new Date().toISOString());

      if (error) {
        fastify.log.error(error);
        return { success: false, error: 'Failed to authorize device' };
      }

      return { success: true };
    }
  );

  // Refresh token
  fastify.post('/refresh', async (request, reply) => {
    // TODO: Implement token refresh
    return reply.status(501).send({ error: 'Not implemented' });
  });
}
