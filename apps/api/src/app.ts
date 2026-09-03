import { access } from 'node:fs/promises';
import { join } from 'node:path';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { AuthService } from './auth/auth-service.js';
import { RateLimiter } from './auth/rate-limiter.js';
import type { AuthRepository } from './auth/auth-repository.js';
import type { Database } from './db/database.js';
import type { AccountService } from './auth/account-service.js';
import type { MusicSourceService } from './music-source/music-source-service.js';
import type { AppConfig } from './config.js';
import { registerAuthRoutes } from './routes/auth-routes.js';
import { registerAccountRoutes } from './routes/account-routes.js';
import { registerHealthRoutes } from './routes/health-routes.js';
import { registerMusicSourceRoutes } from './routes/music-source-routes.js';

export interface BuildAppOptions {
  config: AppConfig;
  authRepository?: AuthRepository;
  authService?: AuthService;
  accountService?: AccountService;
  musicSourceService?: MusicSourceService;
  database?: Database;
  logger?: boolean;
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const app = fastify({
    logger: (options.logger ?? options.config.NODE_ENV !== 'test')
      ? {
          level: options.config.LOG_LEVEL,
          redact: ['req.headers.cookie', 'req.headers.authorization'],
          serializers: {
            req: (request) => ({
              method: request.method,
              url: request.url.split('?', 1)[0],
              hostname: request.hostname,
              remoteAddress: request.ip,
            }),
          },
        }
      : false,
    // Only the Hirmos tunnel peer may supply X-Forwarded-For. Fastify then
    // resolves request.ip from the chain written by the public Nginx edge.
    trustProxy: options.config.NODE_ENV === 'production'
      ? options.config.TRUSTED_PROXIES
      : false,
    requestIdHeader: false,
  });

  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        connectSrc: ["'self'", 'wss:'],
        fontSrc: ["'self'", 'data:'],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        mediaSrc: ["'self'", 'blob:'],
        objectSrc: ["'none'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
      },
    },
    crossOriginResourcePolicy: { policy: 'same-site' },
  });

  app.addHook('onRequest', async (request, reply) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) return;
    const origin = request.headers.origin;
    if (origin && origin !== options.config.PUBLIC_ORIGIN) {
      return reply.code(403).send({
        code: 'ORIGIN_NOT_ALLOWED',
        message: 'El origen de la solicitud no está permitido.',
        requestId: request.id,
      });
    }
  });

  await registerHealthRoutes(app, {
    database: options.database,
  });

  const authService = options.authService ?? (
    options.authRepository ? new AuthService(options.authRepository) : undefined
  );
  const rateLimiter = new RateLimiter();
  if (authService) {
    await registerAuthRoutes(app, {
      authService,
      config: options.config,
      rateLimiter,
    });
  } else {
    app.all('/api/auth/*', async (request, reply) =>
      reply.code(503).send({
        code: 'AUTH_NOT_CONFIGURED',
        message: 'La autenticación todavía no está configurada.',
        requestId: request.id,
      }),
    );
  }

  await registerAccountRoutes(app, options.accountService, rateLimiter);
  await registerMusicSourceRoutes(app, options.musicSourceService);

  const webBuilt = await registerWebBuildIfAvailable(app);

  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith('/api/') || request.url.startsWith('/health/')) {
      return reply.code(404).send({
        code: 'NOT_FOUND',
        message: 'No se encontró el recurso solicitado.',
        requestId: request.id,
      });
    }
    if (webBuilt && request.method === 'GET') {
      return reply.sendFile('index.html');
    }
    return reply.code(404).send({
      code: 'WEB_NOT_BUILT',
      message: 'El cliente web todavía no está disponible en este proceso.',
      requestId: request.id,
    });
  });
  return app;
}

async function registerWebBuildIfAvailable(app: FastifyInstance): Promise<boolean> {
  const root = join(process.cwd(), '../web/dist/web/browser');
  try {
    await access(root);
  } catch {
    return false;
  }
  await app.register(fastifyStatic, {
    root,
  });
  return true;
}
