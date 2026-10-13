import { afterEach, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { AuthService } from '../src/auth/auth-service.js';
import type { Database } from '../src/db/database.js';
import { SessionRevocationNotifier } from '../src/auth/session-revocation.js';

let app: FastifyInstance;
afterEach(async () => { await app?.close(); });
const user = '11111111-1111-4111-8111-111111111111';
const session = '22222222-2222-4222-8222-222222222222';
const target = '33333333-3333-4333-8333-333333333333';
async function setup(rows: unknown[] = []) {
  const query = vi.fn(async (_sql: string, _values?: readonly unknown[]) => ({ rows }));
  const revocations = new SessionRevocationNotifier();
  const notified = vi.fn(); revocations.onSession(notified);
  app = await buildApp({ config: loadConfig({ NODE_ENV: 'test', PUBLIC_ORIGIN: 'http://localhost:4200' }),
    database: { query, transaction: (operation: (tx: { query: typeof query }) => Promise<unknown>) => operation({ query }), close: vi.fn() } as unknown as Database, revocations,
    authService: { authenticate: async (token: string) => token === 'synthetic' ? { id: session,
      response: { user: { id: user, email: 'user@example.test', displayName: 'User', role: 'user' },
        expiresAt: new Date(Date.now() + 100000).toISOString() } } : null } as unknown as AuthService });
  return { query, notified };
}
const headers = { cookie: 'hirmos_session=synthetic', origin: 'http://localhost:4200' };

it('requires authentication and never queries another owner supplied in query/body', async () => {
  const { query } = await setup();
  expect((await app.inject('/api/account/sessions')).statusCode).toBe(401);
  expect((await app.inject({ url: '/api/account/sessions?userId=other', headers })).statusCode).toBe(400);
  expect((await app.inject({ method: 'POST', url: '/api/account/sessions/revoke', headers,
    payload: { scope: 'all', userId: target } })).statusCode).toBe(400);
  expect(query).not.toHaveBeenCalled();
});

it('validates mutation origin and session ID before touching storage', async () => {
  const { query } = await setup();
  expect((await app.inject({ method: 'DELETE', url: `/api/account/sessions/${target}`,
    headers: { ...headers, origin: 'https://other.example.test' } })).statusCode).toBe(403);
  expect((await app.inject({ method: 'DELETE', url: '/api/account/sessions/not-a-uuid', headers })).statusCode).toBe(400);
  expect(query).not.toHaveBeenCalled();
});

it('returns only session metadata and disables browser caching', async () => {
  const date = new Date();
  const { query } = await setup([{ id: session, user_agent: 'Synthetic', created_at: date, last_seen_at: date, expires_at: date,
    token_hash: 'not-public', ip_address: 'not-public' }]);
  const response = await app.inject({ url: '/api/account/sessions', headers });
  expect(response.statusCode).toBe(200); expect(response.headers['cache-control']).toBe('no-store');
  expect(response.json().sessions[0]).toEqual({ id: session, current: true, userAgent: 'Synthetic',
    createdAt: date.toISOString(), lastSeenAt: date.toISOString(), expiresAt: date.toISOString() });
  expect(query.mock.calls[0]?.[1]).toEqual([user, session, 0]);
});

it('does not notify sockets for an unknown or foreign session', async () => {
  const { notified } = await setup([{ found: false, ids: [] }]);
  expect((await app.inject({ method: 'DELETE', url: `/api/account/sessions/${target}`, headers })).statusCode).toBe(404);
  expect(notified).not.toHaveBeenCalled();
});

it('notifies only revoked IDs and clears the current cookie when closing all', async () => {
  const { notified } = await setup([{ found: true, ids: [session, target] }]);
  const result = await app.inject({ method: 'POST', url: '/api/account/sessions/revoke', headers, payload: { scope: 'all' } });
  expect(result.json()).toEqual({ revoked: 2 });
  expect(notified.mock.calls).toEqual([[session], [target]]);
  expect(result.headers['set-cookie']).toContain('hirmos_session=;');
});
