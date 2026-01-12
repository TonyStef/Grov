// Authentication middleware for Fastify
// Validates JWT tokens and attaches user to request

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { verifyToken, type DecodedToken } from '../lib/jwt.js';
import { supabase } from '../db/client.js';

// User object attached to authenticated requests
export interface AuthUser {
  id: string;
  email: string;
  teams: string[];
}

// Extend FastifyRequest to include user
declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser | null;
  }
}

/**
 * Register auth decorator on Fastify instance
 * Must be called before registering routes
 */
export async function authPlugin(fastify: FastifyInstance): Promise<void> {
  // Add user property to all requests
  fastify.decorateRequest('user', null);
}

/**
 * Extract and validate token from Authorization header
 * Tries API JWT first, falls back to Supabase token
 */
async function extractUser(request: FastifyRequest): Promise<AuthUser | null> {
  const authHeader = request.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }

  const token = authHeader.slice(7);

  // Try API JWT first (for CLI clients)
  try {
    const payload = await verifyToken(token);
    if (payload.type === 'access') {
      return {
        id: payload.sub,
        email: payload.email,
        teams: payload.teams || [],
      };
    }
  } catch {
    // Not an API JWT, try Supabase token
  }

  // Try Supabase token (for dashboard)
  const { data: { user: supabaseUser }, error } = await supabase.auth.getUser(token);
  if (!error && supabaseUser) {
    return {
      id: supabaseUser.id,
      email: supabaseUser.email || '',
      teams: [],
    };
  }

  return null;
}

/**
 * Middleware: Require authentication
 * Returns 401 if not authenticated
 * Use as preHandler for protected routes
 */
export async function requireAuth(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const user = await extractUser(request);

  if (!user) {
    return reply.status(401).send({
      error: 'Unauthorized',
      message: 'Valid authentication token required',
    });
  }

  request.user = user;
}

/**
 * Middleware: Optional authentication
 * Attaches user if valid token present, but doesn't reject if missing
 * Use for routes that work with or without auth
 */
export async function optionalAuth(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const user = await extractUser(request);
  request.user = user;
}

// NOTE: requireDashboardAuth was removed for security reasons.
// It trusted X-User-Id and X-User-Email headers without cryptographic verification,
// which could allow header spoofing attacks. Dashboard-to-API authentication
// now uses Supabase access tokens verified directly with Supabase.

/**
 * Helper: Check if request is authenticated
 * Returns true if user is attached to request
 */
export function isAuthenticated(request: FastifyRequest): boolean {
  return request.user !== null;
}

/**
 * Helper: Get authenticated user or throw
 * Use in route handlers after requireAuth middleware
 */
export function getAuthenticatedUser(request: FastifyRequest): AuthUser {
  if (!request.user) {
    throw new Error('User not authenticated - this should not happen after requireAuth');
  }
  return request.user;
}
