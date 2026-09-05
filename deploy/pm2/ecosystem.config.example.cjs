const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');

const envFile = process.env.HIRMOS_ENV_FILE;
if (!envFile) throw new Error('HIRMOS_ENV_FILE must point to a private environment file');

const allowed = new Set([
  'NODE_ENV', 'HOST', 'PORT', 'LOG_LEVEL', 'PUBLIC_ORIGIN', 'TRUSTED_PROXIES', 'DATABASE_URL',
  'DATA_ENCRYPTION_KEY', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER',
  'SMTP_APP_PASSWORD_FILE', 'MAIL_FROM', 'LASTFM_API_KEY',
]);

function loadEnvironment() {
  const values = {};
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator < 1) throw new Error(`Invalid environment line in ${envFile}`);
    const key = trimmed.slice(0, separator).trim();
    if (!allowed.has(key)) throw new Error(`Unexpected environment key: ${key}`);
    values[key] = trimmed.slice(separator + 1).trim();
  }
  return values;
}

module.exports = {
  apps: [{
    name: 'hirmos',
    cwd: resolve(__dirname, '../../apps/api'),
    script: 'dist/server.js',
    interpreter: process.env.HIRMOS_NODE_BIN || process.execPath,
    exec_mode: 'fork',
    instances: 1,
    autorestart: true,
    kill_timeout: 10_000,
    listen_timeout: 10_000,
    max_memory_restart: '768M',
    env: loadEnvironment(),
  }],
};
