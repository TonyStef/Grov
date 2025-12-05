// JWT generation and verification using jose library
// Provides secure token generation for the device authorization flow

import { SignJWT, jwtVerify, type JWTPayload as JoseJWTPayload } from 'jose';

// Get JWT secret from environment
const JWT_SECRET_STRING = process.env.JWT_SECRET;

if (!JWT_SECRET_STRING) {
  throw new Error('JWT_SECRET environment variable is required (minimum 32 characters)');
}

if (JWT_SECRET_STRING.length < 32) {
  throw new Error('JWT_SECRET must be at least 32 characters for security');
}

// Encode secret for jose
const JWT_SECRET = new TextEncoder().encode(JWT_SECRET_STRING);

// Token expiry times
const ACCESS_TOKEN_EXPIRY = '1h';  // 1 hour
const REFRESH_TOKEN_EXPIRY = '7d'; // 7 days

// Custom payload interface
export interface TokenPayload {
  sub: string;        // user_id (UUID)
  email: string;      // user email
  type: 'access' | 'refresh';
  teams?: string[];   // team IDs for authorization cache (optional)
}

// Decoded token with standard JWT claims
export interface DecodedToken extends TokenPayload {
  iat: number;  // issued at
  exp: number;  // expiry
}

/**
 * Generate an access token (short-lived, 1 hour)
 */
export async function generateAccessToken(payload: {
  sub: string;
  email: string;
  teams?: string[];
}): Promise<string> {
  return new SignJWT({
    sub: payload.sub,
    email: payload.email,
    type: 'access',
    teams: payload.teams,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(ACCESS_TOKEN_EXPIRY)
    .setIssuer('grov-api')
    .setAudience('grov-cli')
    .sign(JWT_SECRET);
}

/**
 * Generate a refresh token (long-lived, 7 days)
 */
export async function generateRefreshToken(payload: {
  sub: string;
  email: string;
}): Promise<string> {
  return new SignJWT({
    sub: payload.sub,
    email: payload.email,
    type: 'refresh',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(REFRESH_TOKEN_EXPIRY)
    .setIssuer('grov-api')
    .setAudience('grov-cli')
    .sign(JWT_SECRET);
}

/**
 * Verify and decode a token
 * @throws Error if token is invalid or expired
 */
export async function verifyToken(token: string): Promise<DecodedToken> {
  const { payload } = await jwtVerify(token, JWT_SECRET, {
    issuer: 'grov-api',
    audience: 'grov-cli',
  });

  // Type assertion after validation
  return {
    sub: payload.sub as string,
    email: payload.email as string,
    type: payload.type as 'access' | 'refresh',
    teams: payload.teams as string[] | undefined,
    iat: payload.iat as number,
    exp: payload.exp as number,
  };
}

/**
 * Generate both access and refresh tokens
 */
export async function generateTokenPair(payload: {
  sub: string;
  email: string;
  teams?: string[];
}): Promise<{
  access_token: string;
  refresh_token: string;
  expires_at: string;
}> {
  const [access_token, refresh_token] = await Promise.all([
    generateAccessToken(payload),
    generateRefreshToken(payload),
  ]);

  // Calculate expiry time (1 hour from now)
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

  return {
    access_token,
    refresh_token,
    expires_at: expiresAt.toISOString(),
  };
}

/**
 * Decode token without verification (for debugging/logging)
 * WARNING: Do not use for authentication - always use verifyToken
 */
export function decodeTokenUnsafe(token: string): TokenPayload | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const payload = JSON.parse(
      Buffer.from(parts[1], 'base64url').toString('utf-8')
    );

    return {
      sub: payload.sub,
      email: payload.email,
      type: payload.type,
      teams: payload.teams,
    };
  } catch {
    return null;
  }
}
