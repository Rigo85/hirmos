import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { Database } from '../src/db/database.js';

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('health routes', () => {
  it('reports liveness without external dependencies', async () => {
    app = await buildApp({
      config: loadConfig({ NODE_ENV: 'test', PUBLIC_ORIGIN: 'http://localhost:4200' }),
      logger: false,
    });

    const response = await app.inject({ method: 'GET', url: '/health/live' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('does not claim readiness when the database is absent', async () => {
    app = await buildApp({
      config: loadConfig({ NODE_ENV: 'test', PUBLIC_ORIGIN: 'http://localhost:4200' }),
      logger: false,
    });

    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ status: 'not-ready' });
  });

  it('queries the database before claiming readiness', async () => {
    const database: Database = {
      query: async () => ({ rows: [], command: 'SELECT', rowCount: 1, oid: 0, fields: [] }),
      close: async () => undefined,
    };
    app = await buildApp({
      config: loadConfig({ NODE_ENV: 'test', PUBLIC_ORIGIN: 'http://localhost:4200' }),
      database,
      logger: false,
    });

    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ready', checks: { database: 'available' } });
  });

  it('reports a configured but unavailable database', async () => {
    const database: Database = {
      query: async () => { throw new Error('offline'); },
      close: async () => undefined,
    };
    app = await buildApp({
      config: loadConfig({ NODE_ENV: 'test', PUBLIC_ORIGIN: 'http://localhost:4200' }),
      database,
      logger: false,
    });

    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'not-ready', checks: { database: 'unavailable' } });
  });
});
