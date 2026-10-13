// Only synthetic schemas in a disposable local Hirmos database. No production access.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import pg from 'pg';
import { io as connectSocket } from 'socket.io-client';
import { PLAYBACK_PROTOCOL_VERSION } from '../packages/contracts/dist/index.js';
import { buildApp } from '../apps/api/dist/app.js';
import { loadConfig } from '../apps/api/dist/config.js';
import { createDatabase } from '../apps/api/dist/db/database.js';
import { AuthService, hashSessionToken } from '../apps/api/dist/auth/auth-service.js';
import { PostgresAuthRepository } from '../apps/api/dist/auth/auth-repository.js';
import { SessionRevocationNotifier } from '../apps/api/dist/auth/session-revocation.js';
import { PlaybackRepository } from '../apps/api/dist/playback/playback-repository.js';
import { PlaybackService } from '../apps/api/dist/playback/playback-service.js';
import { createSocketServer } from '../apps/api/dist/socket/socket-server.js';

const url = new URL(process.env.HIRMOS_TEST_DATABASE_URL ?? '');
assert.ok(['localhost', '127.0.0.1'].includes(url.hostname) && url.pathname === '/hirmos_core_test');
const admin = new pg.Client({ connectionString: url.href }); await admin.connect();
const schema = `hirmos_sessions_${randomUUID().replaceAll('-', '')}`;
await admin.query(`CREATE SCHEMA ${schema}`);
url.searchParams.set('options', `-c search_path=${schema} -c statement_timeout=5000`);
const db = createDatabase(url.href);
let app, io; const sockets = []; let checks = 0;
const pass = label => { checks++; console.log(`PASS ${label}`); };
const event = (socket, name) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => { socket.off(name, done); reject(new Error(`Missing ${name}`)); }, 5000);
  function done(value) { clearTimeout(timer); resolve(value); }
  socket.once(name, done);
});
try {
  for (const name of (await readdir(new URL('../database/migrations/', import.meta.url))).filter(n => n.endsWith('.sql')).sort()) {
    await db.query(await readFile(new URL(`../database/migrations/${name}`, import.meta.url), 'utf8'));
  }
  const a = randomUUID(), b = randomUUID();
  await db.query(`INSERT INTO users(id,email,display_name,role) VALUES
    ($1,'sessions-a@example.test','A','user'),($2,'sessions-b@example.test','B','user')`, [a, b]);
  const authRepo = new PostgresAuthRepository(db);
  const revocations = new SessionRevocationNotifier();
  const auth = new AuthService(authRepo, undefined, revocations);
  const make = async (owner, token, agent = 'Synthetic browser') => authRepo.createSession({ userId: owner,
    tokenHash: hashSessionToken(token), expiresAt: new Date(Date.now()+86400000), ipAddress: '127.0.0.1', userAgent: agent });
  const current = await make(a, 'synthetic-current'), remote = await make(a, 'synthetic-remote');
  const foreign = await make(b, 'synthetic-other');
  const expired = await make(a, 'synthetic-expired');
  await db.query("UPDATE auth_sessions SET created_at=now()-interval '2 days',expires_at=now()-interval '1 day' WHERE id=$1", [expired]);
  const config = loadConfig({ NODE_ENV: 'test', PUBLIC_ORIGIN: 'http://localhost:4200' });
  app = await buildApp({ config, database: db, authService: auth, revocations, logger: false });
  const playback = new PlaybackService(new PlaybackRepository(db));
  io = createSocketServer(app.server, config, auth, playback, revocations);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = `http://127.0.0.1:${app.server.address().port}`;
  const headers = token => ({ cookie: `hirmos_session=${token}`, origin: config.PUBLIC_ORIGIN });
  const request = (method, path, payload, token = 'synthetic-current') => app.inject({ method, url: path, headers: headers(token), ...(payload ? { payload } : {}) });
  const list = await request('GET', '/api/account/sessions');
  assert.equal(list.statusCode, 200);
  assert.deepEqual(list.json().sessions.map(s => s.id).sort(), [current, remote].sort());
  assert.equal(list.json().sessions[0].current, true);
  assert.ok(!list.body.includes('token') && !list.body.includes('127.0.0.1'));
  pass('list is owned, current first, excludes expired sessions and never returns tokens or IPs');

  for (const id of [foreign, randomUUID()]) assert.equal((await request('DELETE', `/api/account/sessions/${id}`)).statusCode, 404);
  assert.ok(await auth.authenticate('synthetic-other'));
  pass('foreign and unknown IDs indistinguishable; another account remains authenticated');

  const socket = async token => {
    const client = connectSocket(address, { autoConnect: false, reconnection: false, transports: ['websocket'],
      extraHeaders: headers(token), auth: { protocolVersion: PLAYBACK_PROTOCOL_VERSION, deviceId: randomUUID(), deviceName: 'Synthetic', deviceType: 'desktop' } });
    sockets.push(client); const ready = event(client, 'playback:snapshot'); client.connect(); await ready; return client;
  };
  const local = await socket('synthetic-current');
  const tab1 = await socket('synthetic-remote'), tab2 = await socket('synthetic-remote');
  const anotherUser = await socket('synthetic-other');
  const before = await playback.snapshot(a);
  const closed1 = event(tab1, 'disconnect'), closed2 = event(tab2, 'disconnect');
  const reason = event(tab1, 'playback:error');
  assert.equal((await request('DELETE', `/api/account/sessions/${remote}`)).statusCode, 204);
  assert.equal(await closed1, 'io server disconnect'); assert.equal(await closed2, 'io server disconnect');
  assert.equal((await reason).code, 'UNAUTHENTICATED');
  assert.equal(local.connected, true); assert.equal(anotherUser.connected, true);
  assert.equal(await auth.authenticate('synthetic-remote'), null);
  const after = await playback.snapshot(a);
  assert.equal(after.revision, before.revision); assert.deepEqual(after.queue, before.queue);
  pass('single revoke stops all target tabs, preserves other sockets and durable playback');

  assert.equal((await request('DELETE', `/api/account/sessions/${remote}`)).statusCode, 204);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM security_events WHERE event_type='session.revoked'")).rows[0].n, 1);
  pass('repeated close is harmless and does not duplicate audit');

  const rollback = await make(a, 'synthetic-rollback');
  await db.query(`CREATE FUNCTION reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic audit failure'; END $$;
    CREATE TRIGGER reject_session_audit BEFORE INSERT ON security_events FOR EACH ROW EXECUTE FUNCTION reject_audit()`);
  assert.equal((await request('DELETE', `/api/account/sessions/${rollback}`)).statusCode, 500);
  assert.ok(await auth.authenticate('synthetic-rollback'));
  await db.query('DROP TRIGGER reject_session_audit ON security_events; DROP FUNCTION reject_audit()');
  pass('audit failure rolls back revocation instead of claiming a successful close');

  for (let i=0;i<52;i++) await make(a, `synthetic-page-${i}`);
  const page1 = (await request('GET', '/api/account/sessions')).json();
  const page2 = (await request('GET', '/api/account/sessions?offset=50')).json();
  assert.equal(page1.sessions.length, 50); assert.equal(page1.hasMore, true); assert.equal(page2.sessions.length, 4);
  assert.equal(new Set([...page1.sessions,...page2.sessions].map(s=>s.id)).size, 54);
  pass('bounded pagination does not silently truncate active sessions');

  const others = await Promise.all([request('POST', '/api/account/sessions/revoke', { scope: 'others' }), request('POST', '/api/account/sessions/revoke', { scope: 'others' })]);
  assert.equal(others.reduce((total,r)=>total+r.json().revoked,0),53);
  assert.ok(await auth.authenticate('synthetic-current')); assert.ok(await auth.authenticate('synthetic-other'));
  assert.equal((await request('GET','/api/account/sessions')).json().sessions.length,1);
  pass('concurrent close-others is atomic, keeps current and does not touch another account');

  const closedLocal = event(local, 'disconnect');
  const all = await request('POST','/api/account/sessions/revoke',{ scope:'all' });
  assert.equal(all.statusCode,200); assert.equal(all.json().revoked,1);
  assert.ok(all.headers['set-cookie'].includes('hirmos_session=;'));
  await closedLocal;
  assert.equal((await request('GET','/api/account/sessions')).statusCode,401);
  assert.equal(anotherUser.connected,true);
  pass('close-all clears cookie, invalidates HTTP and sockets, preserves unrelated accounts');
  console.log(`${checks} session management groups passed`);
} finally {
  for (const socket of sockets) socket.disconnect();
  if (io) await new Promise(resolve => io.close(resolve));
  if (app) await app.close();
  await db.close(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
}
