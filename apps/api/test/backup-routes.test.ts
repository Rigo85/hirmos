import { afterEach, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { AuthService } from '../src/auth/auth-service.js';
import type { Database } from '../src/db/database.js';

let app: FastifyInstance;
afterEach(async () => { await app?.close(); });
async function setup(row: Record<string, unknown> = {}, fail = false) {
  const query = vi.fn(async () => {
    if (fail) throw new Error('postgres://secret@private.invalid/secret');
    return { rows: [{ checked_at: new Date('2026-10-01T12:00:00Z'), ...row }] };
  });
  app = await buildApp({ config: loadConfig({ NODE_ENV: 'test' }),
    database: { query, close: vi.fn() } as unknown as Database,
    authService: { authenticate: async (token: string) => ['admin','user'].includes(token) ? {
      id: 'synthetic-session', response: { user: { id: 'synthetic-user', email: 'test@example.test',
        displayName: 'Synthetic', role: token }, expiresAt: new Date(Date.now()+60000).toISOString() },
    } : null } as unknown as AuthService });
  return query;
}
const headers = { cookie: 'hirmos_session=admin' };
it('denies anonymous and listeners before reading operational data', async () => {
  const query = await setup();
  expect((await app.inject('/api/admin/backups')).statusCode).toBe(401);
  expect((await app.inject({ url:'/api/admin/backups', headers:{ cookie:'hirmos_session=user' } })).statusCode).toBe(403);
  expect(query).not.toHaveBeenCalled();
});
it('returns unrecorded state with no-store, never inventing configured scheduling', async () => {
  await setup(); const result = await app.inject({ url:'/api/admin/backups', headers });
  expect(result.statusCode).toBe(200);
  expect(result.headers['cache-control']).toBe('no-store');
  expect(result.json()).toEqual({ checkedAt:'2026-10-01T12:00:00.000Z', thresholdHours:36,
    overdue:true, lastAttempt:null, lastSuccess:null });
});
it('whitelists metadata and marks abandoned execution as interrupted', async () => {
  await setup({ run_id:'private-id', owner_pid:123, started_at:new Date('2026-10-01T11:00:00Z'),
    outcome:'running', active:false, phase:'snapshot', internal_path:'/private/file',
    last_success_at:new Date('2026-09-29T22:00:00Z'), last_snapshot_at:new Date('2026-09-29T20:00:00Z'),
    last_bytes:'12345', last_duration_ms:'2000' });
  const result = await app.inject({ url:'/api/admin/backups', headers });
  expect(result.json().lastAttempt.outcome).toBe('interrupted');
  expect(result.json().lastSuccess.bytes).toBe(12345);
  expect(result.json().overdue).toBe(true);
  expect(result.body).not.toMatch(/private|owner_pid|123,/);
});
it('query failure is unavailable, not an empty or healthy state; hides raw errors', async () => {
  await setup({}, true); const result = await app.inject({ url:'/api/admin/backups', headers });
  expect(result.statusCode).toBe(503);
  expect(result.json()).toEqual({ code:'BACKUP_STATUS_UNAVAILABLE' });
  expect(result.body).not.toContain('secret');
});
