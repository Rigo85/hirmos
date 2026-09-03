import pg from 'pg';
import { AesGcmOutboxCipher } from '../apps/api/dist/mail/outbox-cipher.js';

const databaseUrl = required('DATABASE_URL');
const encryptionKey = required('DATA_ENCRYPTION_KEY');
const adminEmail = required('SMOKE_ADMIN_EMAIL');
const adminPassword = required('SMOKE_ADMIN_PASSWORD');
const apiOrigin = process.env.SMOKE_API_ORIGIN ?? 'http://127.0.0.1:3013';
const listenerEmail = `smoke-${Date.now()}@hirmos.local`;
const initialPassword = 'smoke-initial-password';
const recoveredPassword = 'smoke-recovered-password';
const cipher = new AesGcmOutboxCipher(encryptionKey);
const pool = new pg.Pool({ connectionString: databaseUrl, application_name: 'hirmos-smoke-auth' });

try {
  const adminLogin = await jsonRequest('/api/auth/login', {
    method: 'POST',
    body: { email: adminEmail, password: adminPassword },
  });
  assertStatus(adminLogin, 200, 'admin login');
  const adminCookie = cookieFrom(adminLogin);

  const invite = await jsonRequest('/api/admin/invitations', {
    method: 'POST',
    cookie: adminCookie,
    body: { email: listenerEmail, role: 'user' },
  });
  assertStatus(invite, 202, 'invitation request');
  const invitationToken = await tokenFromOutbox(listenerEmail, 'invitation');

  const accepted = await jsonRequest('/api/auth/invitations/accept', {
    method: 'POST',
    body: { token: invitationToken, displayName: 'Smoke Listener', password: initialPassword },
  });
  assertStatus(accepted, 201, 'invitation acceptance');

  const listenerLogin = await jsonRequest('/api/auth/login', {
    method: 'POST',
    body: { email: listenerEmail, password: initialPassword },
  });
  assertStatus(listenerLogin, 200, 'listener login');
  const listenerCookie = cookieFrom(listenerLogin);

  const recovery = await jsonRequest('/api/auth/recovery/request', {
    method: 'POST',
    body: { email: listenerEmail },
  });
  assertStatus(recovery, 202, 'recovery request');
  const recoveryToken = await tokenFromOutbox(listenerEmail, 'password-recovery');

  const completed = await jsonRequest('/api/auth/recovery/complete', {
    method: 'POST',
    body: { token: recoveryToken, password: recoveredPassword },
  });
  assertStatus(completed, 204, 'recovery completion');

  const revokedSession = await jsonRequest('/api/auth/session', { cookie: listenerCookie });
  assertStatus(revokedSession, 401, 'old session revocation');
  const recoveredLogin = await jsonRequest('/api/auth/login', {
    method: 'POST',
    body: { email: listenerEmail, password: recoveredPassword },
  });
  assertStatus(recoveredLogin, 200, 'login with recovered password');

  console.log(JSON.stringify({
    status: 'ok',
    checks: [
      'admin-login',
      'invitation-one-time-token',
      'invitation-acceptance',
      'listener-login',
      'password-recovery',
      'previous-session-revoked',
      'recovered-login',
    ],
  }));
} finally {
  await pool.end();
}

async function tokenFromOutbox(recipient, type) {
  const result = await pool.query(
    `SELECT template_data_ciphertext, encryption_key_version
       FROM email_outbox
      WHERE recipient = $1 AND message_type = $2
      ORDER BY id DESC
      LIMIT 1`,
    [recipient, type],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`Missing ${type} outbox message`);
  const data = cipher.decrypt(row.template_data_ciphertext, row.encryption_key_version);
  const token = new URL(data.actionUrl).searchParams.get('token');
  if (!token) throw new Error(`Missing token in ${type} action URL`);
  return token;
}

async function jsonRequest(path, options = {}) {
  const headers = {};
  if (options.body) headers['content-type'] = 'application/json';
  if (options.cookie) headers.cookie = options.cookie;
  return fetch(`${apiOrigin}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
}

function cookieFrom(response) {
  const setCookie = response.headers.get('set-cookie');
  if (!setCookie) throw new Error('Response did not set a session cookie');
  return setCookie.split(';', 1)[0];
}

function assertStatus(response, expected, label) {
  if (response.status !== expected) {
    throw new Error(`${label}: expected HTTP ${expected}, received ${response.status}`);
  }
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
