import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { loginRequestSchema } from '@hirmos/contracts';
import type { AppConfig } from '../config.js';
import { AuthService, InvalidCredentialsError } from '../auth/auth-service.js';
import type { RateLimiter } from '../auth/rate-limiter.js';

const COOKIE_PRODUCTION = '__Host-hirmos_session';
const COOKIE_DEVELOPMENT = 'hirmos_session';

export interface AuthRouteOptions {
  authService: AuthService;
  config: AppConfig;
  rateLimiter?: RateLimiter;
}

export async function registerAuthRoutes(
  app: FastifyInstance,
  options: AuthRouteOptions,
): Promise<void> {
  const cookieName = sessionCookieName(options.config);

  app.decorateRequest('authSession', null);

  app.addHook('preHandler', async (request) => {
    const token = request.cookies[cookieName];
    request.authSession = await options.authService.authenticate(token);
  });

  app.post('/api/auth/login', async (request, reply) => {
    const parsed = loginRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        code: 'INVALID_REQUEST',
        message: 'Revisa los datos ingresados.',
        requestId: request.id,
      });
    }
    const limited = enforceRateLimits(
      options.rateLimiter,
      request,
      reply,
      `login:ip:${request.ip}`,
      `login:account:${parsed.data.email.trim().toLowerCase()}`,
      10,
      6,
      15 * 60_000,
    );
    if (limited) return limited;

    try {
      const result = await options.authService.login(
        parsed.data.email,
        parsed.data.password,
        {
          ipAddress: request.ip || null,
          userAgent: normalizeHeader(request.headers['user-agent']),
        },
      );
      setSessionCookie(reply, cookieName, result.token, result.session.expiresAt, options.config);
      return reply.send(result.session);
    } catch (error) {
      if (error instanceof InvalidCredentialsError) {
        return reply.code(401).send({
          code: 'INVALID_CREDENTIALS',
          message: 'El correo o la contraseña no son válidos.',
          requestId: request.id,
        });
      }
      throw error;
    }
  });

  app.get('/api/auth/session', async (request, reply) => {
    if (!request.authSession) {
      return unauthorized(request, reply);
    }
    return reply.send(request.authSession.response);
  });

  app.post('/api/auth/logout', async (request, reply) => {
    if (request.authSession) {
      await options.authService.revoke(request.authSession.id);
    }
    reply.clearCookie(cookieName, cookieOptions(options.config));
    return reply.code(204).send();
  });
}

export function enforceRateLimits(
  limiter: RateLimiter | undefined,
  request: FastifyRequest,
  reply: FastifyReply,
  networkKey: string,
  accountKey: string,
  networkLimit: number,
  accountLimit: number,
  windowMs: number,
): FastifyReply | undefined {
  if (!limiter) return undefined;
  const network = limiter.take('network', networkKey, networkLimit, windowMs);
  const account = limiter.take('account', accountKey, accountLimit, windowMs);
  const retryAfter = Math.max(network.retryAfterSeconds, account.retryAfterSeconds);
  if (network.allowed && account.allowed) return undefined;
  reply.header('retry-after', String(retryAfter));
  return reply.code(429).send({
    code: 'RATE_LIMITED',
    message: 'Demasiados intentos. Espera un momento antes de volver a intentar.',
    requestId: request.id,
  });
}

export function requireAuthentication(
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply | undefined {
  if (!request.authSession) {
    return unauthorized(request, reply);
  }
  return undefined;
}

export function requireAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply | undefined {
  const authReply = requireAuthentication(request, reply);
  if (authReply) return authReply;
  if (request.authSession?.response.user.role !== 'admin') {
    return reply.code(403).send({
      code: 'FORBIDDEN',
      message: 'No tienes permiso para realizar esta acción.',
      requestId: request.id,
    });
  }
  return undefined;
}

export function sessionCookieName(config: AppConfig): string {
  return config.NODE_ENV === 'production' ? COOKIE_PRODUCTION : COOKIE_DEVELOPMENT;
}

function setSessionCookie(
  reply: FastifyReply,
  name: string,
  token: string,
  expiresAt: string,
  config: AppConfig,
): void {
  reply.setCookie(name, token, {
    ...cookieOptions(config),
    expires: new Date(expiresAt),
  });
}

function cookieOptions(config: AppConfig) {
  return {
    path: '/',
    httpOnly: true,
    secure: config.NODE_ENV === 'production',
    sameSite: 'strict' as const,
  };
}

function unauthorized(request: FastifyRequest, reply: FastifyReply): FastifyReply {
  return reply.code(401).send({
    code: 'UNAUTHENTICATED',
    message: 'Inicia sesión para continuar.',
    requestId: request.id,
  });
}

function normalizeHeader(value: string | string[] | undefined): string | null {
  if (!value) return null;
  return Array.isArray(value) ? value.join(', ') : value;
}
