// Grov Proxy Server - Fastify HTTP layer
// Routes requests to appropriate agent adapters via orchestrator

import Fastify, { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { config } from './config.js';
import { checkExtendedCache, log } from './cache/extended-cache.js';
import { setDebugMode } from './utils/logging.js';
import { getAgentForRequest } from './agents/index.js';
import { handleAgentRequest } from './orchestrator.js';
import {
  cleanupOldCompletedSessions,
  cleanupStaleActiveSessions,
  clearStalePendingCorrections,
  cleanupFailedSyncTasks,
} from '../../core/store/store.js';
import { extendedCache } from './cache/extended-cache.js';

/**
 * Create and configure the Fastify server
 */
export function createServer(): FastifyInstance {
  const fastify = Fastify({
    logger: false,
    bodyLimit: config.BODY_LIMIT,
  });

  // Custom JSON parser that preserves raw bytes for cache preservation
  fastify.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    (req as unknown as { rawBody: Buffer }).rawBody = body as Buffer;
    try {
      const json = JSON.parse((body as Buffer).toString('utf-8'));
      done(null, json);
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  // Health check endpoint
  fastify.get('/health', async () => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });

  // Agent endpoints
  fastify.post('/v1/messages', handleRequest);   // Claude
  fastify.post('/v1/responses', handleRequest);  // Codex

  // Catch-all for unhandled endpoints
  fastify.all('/*', async (request, reply) => {
    fastify.log.warn(`Unhandled endpoint: ${request.method} ${request.url}`);
    return reply.status(404).send({ error: 'Not found' });
  });

  return fastify;
}

/**
 * Handle incoming agent requests
 */
async function handleRequest(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const adapter = getAgentForRequest(request);

  if (!adapter) {
    return reply.status(404).send({ error: 'Unknown agent endpoint' });
  }

  const rawBody = (request as unknown as { rawBody?: Buffer }).rawBody;

  const result = await handleAgentRequest({
    adapter,
    body: request.body,
    headers: request.headers as Record<string, string>,
    rawBody,
    logger: {
      info: (data) => request.log.info(data),
      error: (data) => request.log.error(data),
    },
  });

  return reply
    .status(result.statusCode)
    .header('content-type', result.contentType)
    .headers(result.headers)
    .send(result.body);
}

/**
 * Start the proxy server
 */
export async function startServer(options: { debug?: boolean } = {}): Promise<FastifyInstance> {
  if (options.debug) {
    setDebugMode(true);
  }

  const server = createServer();

  // Startup cleanup
  cleanupOldCompletedSessions();
  cleanupFailedSyncTasks();

  const staleCount = cleanupStaleActiveSessions();
  if (staleCount > 0) {
    log(`Cleaned up ${staleCount} stale active session(s)`);
  }

  // Start extended cache timer if enabled
  let extendedCacheTimer: NodeJS.Timeout | null = null;

  // Track active connections for graceful shutdown
  const activeConnections = new Set<import('net').Socket>();
  let isShuttingDown = false;

  const gracefulShutdown = () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    log('Shutdown initiated...');

    if (extendedCacheTimer) {
      clearInterval(extendedCacheTimer);
      extendedCacheTimer = null;
    }

    if (extendedCache.size > 0) {
      for (const entry of extendedCache.values()) {
        for (const key of Object.keys(entry.headers)) {
          entry.headers[key] = '';
        }
        entry.rawBody = Buffer.alloc(0);
      }
      extendedCache.clear();
    }

    server.close();

    setTimeout(() => {
      if (activeConnections.size > 0) {
        log(`Force closing ${activeConnections.size} connection(s)`);
        for (const socket of activeConnections) {
          socket.destroy();
        }
      }
      log('Goodbye!');
      process.exit(0);
    }, 500);
  };

  process.on('SIGTERM', gracefulShutdown);
  process.on('SIGINT', gracefulShutdown);

  if (config.EXTENDED_CACHE_ENABLED) {
    extendedCacheTimer = setInterval(checkExtendedCache, 60_000);
    log('Extended cache: enabled (keep-alive timer started)');
  }

  clearStalePendingCorrections();

  try {
    await server.listen({
      host: config.HOST,
      port: config.PORT,
    });

    server.server.on('connection', (socket: import('net').Socket) => {
      activeConnections.add(socket);
      socket.on('close', () => activeConnections.delete(socket));
    });

    console.log(`Grov Proxy: http://${config.HOST}:${config.PORT}`);

    return server;
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
}

// CLI entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  startServer();
}
