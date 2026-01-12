// Load environment variables FIRST (side-effect import)
import 'dotenv/config';

import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';

// Validate required environment variables
const requiredEnvVars = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'JWT_SECRET'];
for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.error(`Missing required environment variable: ${envVar}`);
    process.exit(1);
  }
}

if (process.env.JWT_SECRET && process.env.JWT_SECRET.length < 32) {
  console.error('JWT_SECRET must be at least 32 characters');
  process.exit(1);
}

// Import auth plugin
import { authPlugin } from './middleware/auth.js';

// Import routes
import authRoutes from './routes/auth.js';
import teamsRoutes from './routes/teams.js';
import memoriesRoutes from './routes/memories.js';
import cursorRoutes from './routes/cursor.js';
import antigravityRoutes from './routes/antigravity.js';
import { billingPublicRoutes, billingTeamRoutes } from './routes/billing.js';

// Create Fastify instance with security defaults
// Log to file in development for debugging
import { createWriteStream, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

function getLogStream() {
  if (process.env.LOG_TO_FILE !== 'true') return undefined;
  const grovDir = join(homedir(), '.grov');
  if (!existsSync(grovDir)) mkdirSync(grovDir, { recursive: true });
  return createWriteStream(join(grovDir, 'grov-api.log'), { flags: 'a' });
}

const fastify = Fastify({
  logger: {
    level: process.env.LOG_LEVEL || 'error',  // Only errors (minimal logging)
    stream: getLogStream(),
  },
  // Security: Limit request body size to prevent DoS
  bodyLimit: 1048576, // 1MB max body size
  // Disable request logging (minimal logging)
  disableRequestLogging: true,
});

// Register plugins
await fastify.register(cors, {
  origin: process.env.CORS_ORIGIN || 'http://localhost:3000',
  credentials: true,
});

await fastify.register(helmet, {
  // Enable security headers
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameSrc: ["'none'"],
      upgradeInsecureRequests: [],
    },
  },
  // Strict Transport Security
  hsts: {
    maxAge: 31536000, // 1 year
    includeSubDomains: true,
    preload: true,
  },
  // Prevent clickjacking
  frameguard: { action: 'deny' },
  // Prevent MIME type sniffing
  noSniff: true,
  // XSS filter
  xssFilter: true,
});

// Register rate limiting with global defaults
await fastify.register(rateLimit, {
  max: 100, // 100 requests per window
  timeWindow: '1 minute',
  errorResponseBuilder: (request, context) => ({
    error: 'Too Many Requests',
    message: `Rate limit exceeded. Try again in ${Math.ceil(context.ttl / 1000)} seconds.`,
    statusCode: 429,
  }),
});

// Register auth plugin (adds user decorator to requests)
await fastify.register(authPlugin);

// Health check
fastify.get('/health', async () => {
  return { status: 'ok', timestamp: new Date().toISOString() };
});

// Register routes
await fastify.register(authRoutes, { prefix: '/auth' });
await fastify.register(teamsRoutes, { prefix: '/teams' });
await fastify.register(memoriesRoutes, { prefix: '/teams' });
await fastify.register(cursorRoutes, { prefix: '/teams' });
await fastify.register(antigravityRoutes, { prefix: '/teams' });
await fastify.register(billingPublicRoutes, { prefix: '/billing' });
await fastify.register(billingTeamRoutes, { prefix: '/teams' });

// Start server
const start = async () => {
  try {
    const host = process.env.HOST || '0.0.0.0';
    const port = parseInt(process.env.PORT || '3001', 10);

    await fastify.listen({ host, port });
    console.log(` API server running at http://${host}:${port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
