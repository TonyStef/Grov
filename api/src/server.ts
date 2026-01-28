import 'dotenv/config';

import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';

const REQUIRED_ENV_VARS = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'JWT_SECRET'];
const MIN_JWT_LENGTH = 32;

function validateEnvironment() {
  for (const envVar of REQUIRED_ENV_VARS) {
    if (!process.env[envVar]) {
      console.error(`Missing required environment variable: ${envVar}`);
      process.exit(1);
    }
  }

  if (process.env.JWT_SECRET && process.env.JWT_SECRET.length < MIN_JWT_LENGTH) {
    console.error(`JWT_SECRET must be at least ${MIN_JWT_LENGTH} characters`);
    process.exit(1);
  }
}

validateEnvironment();

// Import auth plugin
import { authPlugin } from './middleware/auth.js';

// Import routes
import authRoutes from './routes/auth.js';
import teamsRoutes from './routes/teams.js';
import memoriesRoutes from './routes/memories.js';
import cursorRoutes from './routes/cursor.js';
import antigravityRoutes from './routes/antigravity.js';
import branchesRoutes from './routes/branches.js';
import plansRoutes from './routes/plans.js';
import { billingPublicRoutes, billingTeamRoutes } from './routes/billing.js';
import { usagePublicRoutes, usageTeamRoutes } from './routes/usage.js';

import { createWriteStream, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const MAX_BODY_SIZE = 1048576; // 1MB
const LOG_FILE_NAME = 'grov-api.log';

function getLogStream() {
  if (process.env.LOG_TO_FILE !== 'true') {
    return undefined;
  }

  const grovDir = join(homedir(), '.grov');
  if (!existsSync(grovDir)) {
    mkdirSync(grovDir, { recursive: true });
  }

  return createWriteStream(join(grovDir, LOG_FILE_NAME), { flags: 'a' });
}

const fastify = Fastify({
  logger: {
    level: process.env.LOG_LEVEL || 'error',
    stream: getLogStream(),
  },
  bodyLimit: MAX_BODY_SIZE,
  disableRequestLogging: true,
});

const DEFAULT_CORS_ORIGIN = 'http://localhost:3000';
const HSTS_MAX_AGE = 31536000; // 1 year in seconds
const RATE_LIMIT_MAX = 100;
const RATE_LIMIT_WINDOW = '1 minute';

await fastify.register(cors, {
  origin: process.env.CORS_ORIGIN || DEFAULT_CORS_ORIGIN,
  credentials: true,
});

await fastify.register(helmet, {
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
  hsts: {
    maxAge: HSTS_MAX_AGE,
    includeSubDomains: true,
    preload: true,
  },
  frameguard: { action: 'deny' },
  noSniff: true,
  xssFilter: true,
});

await fastify.register(rateLimit, {
  max: RATE_LIMIT_MAX,
  timeWindow: RATE_LIMIT_WINDOW,
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
await fastify.register(branchesRoutes, { prefix: '/teams' });
await fastify.register(plansRoutes, { prefix: '/teams' });
await fastify.register(billingPublicRoutes, { prefix: '/billing' });
await fastify.register(billingTeamRoutes, { prefix: '/teams' });
await fastify.register(usagePublicRoutes, { prefix: '/usage' });
await fastify.register(usageTeamRoutes, { prefix: '/teams' });

const DEFAULT_HOST = '0.0.0.0';
const DEFAULT_PORT = '3001';

async function startServer() {
  try {
    const host = process.env.HOST || DEFAULT_HOST;
    const port = parseInt(process.env.PORT || DEFAULT_PORT, 10);

    await fastify.listen({ host, port });
    console.log(` API server running at http://${host}:${port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

startServer();
