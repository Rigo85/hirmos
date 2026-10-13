import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { accountSessionsQuerySchema, revokeAccountSessionsSchema } from '@hirmos/contracts';
import type { Database } from '../db/database.js';
import type { AppConfig } from '../config.js';
import type { SessionRevocationNotifier } from '../auth/session-revocation.js';
import { SessionManagementRepository } from '../auth/session-management-repository.js';
import { requireAuthentication, sessionCookieName } from './auth-routes.js';

export async function registerSessionManagementRoutes(app: FastifyInstance, config: AppConfig,
  database?: Database, revocations?: SessionRevocationNotifier): Promise<void> {
  const repository = database ? new SessionManagementRepository(database) : null;
  await app.register(async scope => {
    scope.addHook('preHandler', async (request, reply) => {
      reply.header('cache-control', 'no-store');
      const denied = requireAuthentication(request, reply);
      if (denied) return denied;
      if (!repository) return reply.code(503).send({ code: 'ACCOUNT_UNAVAILABLE', message: 'No pudimos consultar tu cuenta.' });
    });
    scope.get('/api/account/sessions', async (request, reply) => {
      const parsed = accountSessionsQuerySchema.safeParse(request.query);
      if (!parsed.success) return reply.code(400).send({ code: 'INVALID_REQUEST' });
      const actor = request.authSession!;
      return repository!.list(actor.response.user.id, actor.id, parsed.data.offset);
    });
    scope.delete('/api/account/sessions/:id', async (request, reply) => {
      const parsed = z.object({ id: z.uuid() }).safeParse(request.params);
      if (!parsed.success) return reply.code(400).send({ code: 'INVALID_REQUEST' });
      const actor = request.authSession!;
      const result = await repository!.revoke(actor.response.user.id, actor.id, { id: parsed.data.id });
      if (!result.found) return reply.code(404).send({ code: 'SESSION_NOT_FOUND', message: 'La sesión no está disponible.' });
      for (const id of result.ids) revocations?.session(id);
      if (parsed.data.id === actor.id) reply.clearCookie(sessionCookieName(config), { path: '/' });
      return reply.code(204).send();
    });
    scope.post('/api/account/sessions/revoke', async (request, reply) => {
      const parsed = revokeAccountSessionsSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ code: 'INVALID_REQUEST' });
      const actor = request.authSession!;
      const result = await repository!.revoke(actor.response.user.id, actor.id, parsed.data);
      for (const id of result.ids) revocations?.session(id);
      if (parsed.data.scope === 'all') reply.clearCookie(sessionCookieName(config), { path: '/' });
      return { revoked: result.ids.length };
    });
  });
}
