import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  acceptInvitationRequestSchema,
  completeRecoveryRequestSchema,
  createInvitationRequestSchema,
  recoveryRequestSchema,
} from '@hirmos/contracts';
import { AccountService, InvalidOrExpiredTokenError } from '../auth/account-service.js';
import { enforceRateLimits, requireAdmin } from './auth-routes.js';
import type { RateLimiter } from '../auth/rate-limiter.js';

export async function registerAccountRoutes(
  app: FastifyInstance,
  accountService: AccountService | undefined,
  rateLimiter?: RateLimiter,
): Promise<void> {
  app.post('/api/admin/invitations', async (request, reply) => {
    const denied = requireAdmin(request, reply);
    if (denied) return denied;
    if (!accountService) return notConfigured(request, reply);
    const parsed = createInvitationRequestSchema.safeParse(request.body);
    if (!parsed.success) return invalidRequest(request, reply);
    const limited = enforceRateLimits(
      rateLimiter,
      request,
      reply,
      `invite:ip:${request.ip}`,
      `invite:recipient:${parsed.data.email.trim().toLowerCase()}`,
      30,
      5,
      60 * 60_000,
    );
    if (limited) return limited;
    const created = await accountService.invite(
      parsed.data.email,
      parsed.data.role,
      request.authSession!.response.user.id,
    );
    if (!created) {
      return reply.code(409).send({
        code: 'ACCOUNT_EXISTS',
        message: 'Ya existe una cuenta activa para ese correo.',
        requestId: request.id,
      });
    }
    return reply.code(202).send({ status: 'queued' });
  });

  app.post('/api/auth/invitations/accept', async (request, reply) => {
    if (!accountService) return notConfigured(request, reply);
    const parsed = acceptInvitationRequestSchema.safeParse(request.body);
    if (!parsed.success) return invalidRequest(request, reply);
    const limited = enforceRateLimits(
      rateLimiter,
      request,
      reply,
      `invite-accept:ip:${request.ip}`,
      `invite-accept:token:${parsed.data.token}`,
      20,
      5,
      15 * 60_000,
    );
    if (limited) return limited;
    try {
      const user = await accountService.acceptInvitation(
        parsed.data.token,
        parsed.data.displayName,
        parsed.data.password,
      );
      return reply.code(201).send({ user });
    } catch (error) {
      if (error instanceof InvalidOrExpiredTokenError) return invalidToken(request, reply);
      throw error;
    }
  });

  app.post('/api/auth/recovery/request', async (request, reply) => {
    if (!accountService) return notConfigured(request, reply);
    const parsed = recoveryRequestSchema.safeParse(request.body);
    if (!parsed.success) return invalidRequest(request, reply);
    const limited = enforceRateLimits(
      rateLimiter,
      request,
      reply,
      `recovery:ip:${request.ip}`,
      `recovery:account:${parsed.data.email.trim().toLowerCase()}`,
      20,
      5,
      15 * 60_000,
    );
    if (limited) return limited;
    await accountService.requestRecovery(parsed.data.email);
    return reply.code(202).send({ status: 'accepted' });
  });

  app.post('/api/auth/recovery/complete', async (request, reply) => {
    if (!accountService) return notConfigured(request, reply);
    const parsed = completeRecoveryRequestSchema.safeParse(request.body);
    if (!parsed.success) return invalidRequest(request, reply);
    const limited = enforceRateLimits(
      rateLimiter,
      request,
      reply,
      `recovery-complete:ip:${request.ip}`,
      `recovery-complete:token:${parsed.data.token}`,
      20,
      5,
      15 * 60_000,
    );
    if (limited) return limited;
    try {
      await accountService.completeRecovery(parsed.data.token, parsed.data.password);
      return reply.code(204).send();
    } catch (error) {
      if (error instanceof InvalidOrExpiredTokenError) return invalidToken(request, reply);
      throw error;
    }
  });
}

function invalidRequest(request: FastifyRequest, reply: FastifyReply): FastifyReply {
  return reply.code(400).send({
    code: 'INVALID_REQUEST',
    message: 'Revisa los datos ingresados.',
    requestId: request.id,
  });
}

function invalidToken(request: FastifyRequest, reply: FastifyReply): FastifyReply {
  return reply.code(400).send({
    code: 'INVALID_OR_EXPIRED_TOKEN',
    message: 'El enlace no es válido o ya expiró.',
    requestId: request.id,
  });
}

function notConfigured(request: FastifyRequest, reply: FastifyReply): FastifyReply {
  return reply.code(503).send({
    code: 'ACCOUNT_MAIL_NOT_CONFIGURED',
    message: 'Las invitaciones y la recuperación aún no están configuradas.',
    requestId: request.id,
  });
}
