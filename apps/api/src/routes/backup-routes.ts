import type { FastifyInstance } from 'fastify';
import type { Database } from '../db/database.js';
import { requireAdmin } from './auth-routes.js';
import { readBackupStatus } from '../backup/backup-status.js';

export async function registerBackupRoutes(app: FastifyInstance, db?: Database): Promise<void> {
  app.get('/api/admin/backups', { preHandler: async (request, reply) => {
    reply.header('cache-control', 'no-store');
    return requireAdmin(request, reply);
  } }, async (_request, reply) => {
    if (!db) return reply.code(503).send({ code: 'BACKUP_STATUS_UNAVAILABLE' });
    try { return await readBackupStatus(db); }
    catch {
      app.log.warn({ event: 'backup_status_unavailable' }, 'Backup status query failed');
      return reply.code(503).send({ code: 'BACKUP_STATUS_UNAVAILABLE' });
    }
  });
}
