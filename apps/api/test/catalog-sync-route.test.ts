import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AuthService } from '../src/auth/auth-service.js';
import { buildApp } from '../src/app.js';
import type { CatalogSyncControl } from '../src/cache/catalog-sync-coordinator.js';
import { loadConfig } from '../src/config.js';
import type { MusicSourceService } from '../src/music-source/music-source-service.js';

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('manual catalog synchronization route', () => {
  it('allows only an administrator to start the background synchronization', async () => {
    const completion = Promise.resolve({
      counts: { artists: 82, albums: 590, tracks: 6888 }, followUpError: null,
    });
    const trigger = vi.fn(() => ({ started: true, completion }));
    const status = vi.fn(() => ({
      status: 'running' as const,
      startedAt: '2026-09-08T10:00:00.000Z', completedAt: null, counts: null,
    }));
    const catalogSync: CatalogSyncControl = { trigger, status };
    app = await buildApp({
      config: loadConfig({ NODE_ENV: 'test', PUBLIC_ORIGIN: 'http://localhost:4200' }),
      authService: fakeAuthService(),
      musicSourceService: {
        currentForAdmin: vi.fn(async () => configuredSource()),
      } as unknown as MusicSourceService,
      catalogSync,
      logger: false,
    });

    const forbidden = await app.inject({
      method: 'POST', url: '/api/admin/music-source/sync',
      headers: { cookie: 'hirmos_session=user' }, payload: {},
    });
    expect(forbidden.statusCode).toBe(403);
    expect(trigger).not.toHaveBeenCalled();

    const accepted = await app.inject({
      method: 'POST', url: '/api/admin/music-source/sync',
      headers: { cookie: 'hirmos_session=admin' }, payload: {},
    });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json()).toEqual({
      started: true, status: 'running',
      startedAt: '2026-09-08T10:00:00.000Z', completedAt: null, counts: null,
    });
    expect(trigger).toHaveBeenCalledTimes(1);
  });

  it('queues a source-scoped top songs revalidation for administrators only', async () => {
    const topSongsRefresh = {
      enqueueAll: vi.fn(async () => 84),
      stats: vi.fn(async () => ({
        pending: 84, running: 0, completed: 0, failed: 0,
        artists: 84, useful: 64, empty: 20, stale: 84,
      })),
    };
    app = await buildApp({
      config: loadConfig({ NODE_ENV: 'test', PUBLIC_ORIGIN: 'http://localhost:4200' }),
      authService: fakeAuthService(),
      musicSourceService: {
        currentForAdmin: vi.fn(async () => configuredSource()),
      } as unknown as MusicSourceService,
      topSongsRefresh,
      logger: false,
    });

    const forbidden = await app.inject({
      method: 'POST', url: '/api/admin/music-source/top-songs/revalidate',
      headers: { cookie: 'hirmos_session=user' }, payload: {},
    });
    expect(forbidden.statusCode).toBe(403);
    expect(topSongsRefresh.enqueueAll).not.toHaveBeenCalled();

    const accepted = await app.inject({
      method: 'POST', url: '/api/admin/music-source/top-songs/revalidate',
      headers: { cookie: 'hirmos_session=admin' }, payload: {},
    });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json()).toMatchObject({ queued: 84, pending: 84, artists: 84, useful: 64 });
    expect(topSongsRefresh.enqueueAll).toHaveBeenCalledWith(configuredSource().id);
  });
});

function fakeAuthService(): AuthService {
  return {
    authenticate: vi.fn(async (token?: string) => {
      if (token !== 'admin' && token !== 'user') return null;
      return {
        id: `session-${token}`,
        response: {
          user: {
            id: token === 'admin'
              ? '11111111-1111-4111-8111-111111111111'
              : '22222222-2222-4222-8222-222222222222',
            email: `${token}@example.test`, displayName: token,
            role: token === 'admin' ? 'admin' as const : 'user' as const,
          },
          expiresAt: '2026-10-08T10:00:00.000Z',
        },
      };
    }),
  } as unknown as AuthService;
}

function configuredSource() {
  return {
    id: '33333333-3333-4333-8333-333333333333', name: 'Biblioteca',
    baseUrl: 'http://music.example.test', adapterType: 'navidrome' as const,
    enabled: true, healthy: true, capabilities: [], serverVersion: '1',
    lastCheckedAt: null, lastSyncedAt: '2026-09-08T09:00:00.000Z',
  };
}
