import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { config } from 'dotenv';

// Load environment variables
config();

// Import routes
import authRoutes from './routes/auth.js';
import teamsRoutes from './routes/teams.js';
import memoriesRoutes from './routes/memories.js';

// Create Fastify instance
const fastify = Fastify({
  logger: {
    level: process.env.LOG_LEVEL || 'info',
    transport: process.env.NODE_ENV === 'development'
      ? { target: 'pino-pretty' }
      : undefined,
  },
});

// Register plugins
await fastify.register(cors, {
  origin: process.env.CORS_ORIGIN || 'http://localhost:3000',
  credentials: true,
});

await fastify.register(helmet, {
  contentSecurityPolicy: false,
});

// Health check
fastify.get('/health', async () => {
  return { status: 'ok', timestamp: new Date().toISOString() };
});

// Register routes
await fastify.register(authRoutes, { prefix: '/auth' });
await fastify.register(teamsRoutes, { prefix: '/teams' });
await fastify.register(memoriesRoutes, { prefix: '/teams' });

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
