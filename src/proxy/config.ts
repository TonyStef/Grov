// Proxy configuration

export const config = {
  // Server
  HOST: process.env.PROXY_HOST || '127.0.0.1',
  PORT: parseInt(process.env.PROXY_PORT || '8080', 10),

  // Anthropic target
  ANTHROPIC_BASE_URL: process.env.ANTHROPIC_TARGET || 'https://api.anthropic.com',

  // Timeouts
  REQUEST_TIMEOUT: parseInt(process.env.REQUEST_TIMEOUT || '300000', 10), // 5 minutes
  BODY_LIMIT: parseInt(process.env.BODY_LIMIT || '10485760', 10), // 10MB

  // Drift settings
  DRIFT_CHECK_INTERVAL: parseInt(process.env.DRIFT_CHECK_INTERVAL || '3', 10),
  TOKEN_WARNING_THRESHOLD: parseInt(process.env.TOKEN_WARNING_THRESHOLD || '160000', 10), // 80%
  TOKEN_CLEAR_THRESHOLD: parseInt(process.env.TOKEN_CLEAR_THRESHOLD || '180000', 10), // 90%

  // Security (Phase 2 - disabled for local)
  ENABLE_AUTH: process.env.ENABLE_AUTH === 'true',
  ENABLE_RATE_LIMIT: process.env.ENABLE_RATE_LIMIT === 'true',
  ENABLE_TLS: process.env.ENABLE_TLS === 'true',

  // Logging
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
  LOG_REQUESTS: process.env.LOG_REQUESTS !== 'false',

  // Extended Cache - preserve Anthropic prompt cache during idle
  EXTENDED_CACHE_ENABLED: process.env.GROV_EXTENDED_CACHE === 'true',
};

// Headers to forward to Anthropic (whitelist approach)
export const FORWARD_HEADERS = [
  'x-api-key',
  'authorization',  // Claude Code uses this instead of x-api-key
  'anthropic-version',
  'content-type',
  'anthropic-beta',
];

// Headers to never log
export const SENSITIVE_HEADERS = [
  'x-api-key',
  'authorization',
];

/**
 * Mask sensitive header value for logging
 */
export function maskSensitiveValue(key: string, value: string): string {
  const lowerKey = key.toLowerCase();
  if (SENSITIVE_HEADERS.includes(lowerKey)) {
    if (value.length <= 10) {
      return '***';
    }
    return value.substring(0, 7) + '...' + value.substring(value.length - 4);
  }
  return value;
}

/**
 * Build safe headers for forwarding
 * Handles case-insensitive header matching
 */
export function buildSafeHeaders(
  incomingHeaders: Record<string, string | string[] | undefined>
): Record<string, string> {
  const safe: Record<string, string> = {};

  // Create lowercase map of incoming headers
  const lowerHeaders: Record<string, string | string[] | undefined> = {};
  for (const [key, value] of Object.entries(incomingHeaders)) {
    lowerHeaders[key.toLowerCase()] = value;
  }

  for (const header of FORWARD_HEADERS) {
    const value = lowerHeaders[header.toLowerCase()];
    if (value) {
      safe[header] = Array.isArray(value) ? value[0] : value;
    }
  }

  return safe;
}
