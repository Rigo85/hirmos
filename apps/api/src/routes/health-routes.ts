import type { FastifyInstance } from 'fastify';
import type { Database } from '../db/database.js';

export interface HealthDependencies {
  database?: Database;
}

export async function registerHealthRoutes(
  app: FastifyInstance,
  dependencies: HealthDependencies,
): Promise<void> {
  app.get('/health/live', async () => ({ status: 'ok' }));
  app.get('/health/ready', async (_request, reply) => {
    if (!dependencies.database) {
      return reply.code(503).send({
        status: 'not-ready',
        checks: { database: 'not-configured' },
      });
    }
    try {
      await dependencies.database.query('SELECT 1');
    } catch {
      return reply.code(503).send({
        status: 'not-ready',
        checks: { database: 'unavailable' },
      });
    }
    return reply.send({
      status: 'ready',
      checks: { database: 'available' },
    });
  });
}
