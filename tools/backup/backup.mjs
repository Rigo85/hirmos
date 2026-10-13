import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, readdir, readFile, realpath, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pg from 'pg';

const execute = promisify(execFile);
const backupName = /^hirmos-backup-\d{8}T\d{9}Z-[0-9a-f-]{36}$/;
const artifactName = /^(?:database\.dump|lyrics\/[a-f0-9]{64}|config\/\d{3}-[a-zA-Z0-9_.-]+)$/;
const DAY = 86400000;

export function postgresEnvironment(connectionString) {
  const url = new URL(connectionString);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.username) {
    throw new Error('BACKUP_INVALID_CONNECTION');
  }
  const options = { sslmode: 'PGSSLMODE', sslcert: 'PGSSLCERT', sslkey: 'PGSSLKEY',
    sslrootcert: 'PGSSLROOTCERT', application_name: 'PGAPPNAME' };
  // Do not inherit PGHOSTADDR/PGSERVICE etc. that could silently redirect pg_dump.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PG')));
  Object.assign(env, { PGHOST: url.hostname.replace(/^\[|\]$/g, ''), PGPORT: url.port || '5432',
    PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: decodeURIComponent(url.pathname.slice(1)), PGCONNECT_TIMEOUT: '10' });
  for (const [key, value] of url.searchParams) {
    if (!Object.hasOwn(options, key)) throw new Error('BACKUP_UNSUPPORTED_CONNECTION_OPTION');
    env[options[key]] = value;
  }
  return env;
}

export function retainedBackups(backups) {
  const sorted = [...backups].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const keep = new Set();
  for (const [limit, key] of [
    [14, d => d.toISOString().slice(0, 10)],
    [8, d => String(Math.floor((d.valueOf() + 3 * DAY) / (7 * DAY)))],
    [6, d => d.toISOString().slice(0, 7)],
  ]) {
    const buckets = new Set();
    for (const backup of sorted) {
      const bucket = key(new Date(backup.createdAt));
      if (buckets.size < limit && !buckets.has(bucket)) {
        buckets.add(bucket); keep.add(backup.name);
      }
    }
  }
  return keep;
}

async function checksum(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function regularFile(path, root) {
  if (!(await lstat(path)).isFile()) throw new Error('BACKUP_NOT_REGULAR_FILE');
  if (await realpath(path) !== join(await realpath(root), path.slice(root.length + 1))) {
    throw new Error('BACKUP_SYMBOLIC_LINK');
  }
}

export async function verifyBackup(directory, expectedDatabase) {
  if ((await lstat(directory)).isSymbolicLink()) throw new Error('BACKUP_SYMBOLIC_LINK');
  await regularFile(join(directory, 'manifest.json'), directory);
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  if (manifest.kind !== 'hirmos-backup' || manifest.version !== 1
    || manifest.database !== expectedDatabase || !Number.isFinite(Date.parse(manifest.createdAt))
    || !Array.isArray(manifest.artifacts) || !manifest.artifacts.some(item => item.path === 'database.dump')) {
    throw new Error('BACKUP_INVALID_MANIFEST');
  }
  const seen = new Set();
  for (const item of manifest.artifacts) {
    if (!artifactName.test(item.path) || seen.has(item.path)
      || !/^[a-f0-9]{64}$/.test(item.sha256) || !Number.isSafeInteger(item.bytes) || item.bytes < 0) {
      throw new Error('BACKUP_INVALID_ARTIFACT');
    }
    seen.add(item.path);
    const path = join(directory, item.path);
    await regularFile(path, directory);
    if ((await lstat(path)).size !== item.bytes || await checksum(path) !== item.sha256) {
      throw new Error('BACKUP_CHECKSUM_MISMATCH');
    }
  }
  return manifest;
}

export async function validateDestination(config) {
  const destination = resolve(config.directory);
  const mount = resolve(config.mount);
  if (!isAbsolute(config.directory) || !isAbsolute(config.mount)
    || mount === '/' || !destination.startsWith(`${mount}/`)
    || !basename(destination).startsWith('hirmos-backups')) throw new Error('BACKUP_UNSAFE_DESTINATION');
  // findmnt --mountpoint fails if this is merely a directory on the system disk.
  const { stdout } = await execute('findmnt', ['--noheadings', '--raw', '--mountpoint', mount, '--output', 'TARGET']);
  if (stdout.trim() !== mount || await realpath(mount) !== mount) throw new Error('BACKUP_MOUNT_MISSING');
  if (config.cacheDirectory && (destination.startsWith(`${resolve(config.cacheDirectory)}/`)
    || destination === resolve(config.cacheDirectory))) throw new Error('BACKUP_INSIDE_CACHE');
  if (await realpath(dirname(destination)) !== dirname(destination)) throw new Error('BACKUP_SYMBOLIC_LINK');
  await mkdir(destination, { recursive: true, mode: 0o700 });
  if (await realpath(destination) !== destination) throw new Error('BACKUP_SYMBOLIC_LINK');
  return destination;
}

export async function createBackup(config, connectionString) {
  const url = new URL(connectionString);
  const database = decodeURIComponent(url.pathname.slice(1));
  if (!/^hirmos(?:_[a-z0-9_]+)?$/.test(database)) throw new Error('BACKUP_WRONG_DATABASE');
  const pgEnv = postgresEnvironment(connectionString);
  const client = new pg.Client({ connectionString, application_name: 'hirmos-backup', connectionTimeoutMillis: 10000,
    query_timeout: 15000 });
  let connected = false;
  let recorded = false;
  let published = false;
  let phase = 'destination';
  const runId = randomUUID();
  const started = performance.now();
  try {
    await client.connect(); connected = true;
    const identity = (await client.query('SELECT current_database() AS name')).rows[0].name;
    if (identity !== database) throw new Error('BACKUP_WRONG_DATABASE');
    // Session lock is released even after process death/power failure. No stale
    // lockfile can permanently disable tomorrow's backup.
    const acquired = (await client.query("SELECT pg_try_advisory_lock(hashtextextended('hirmos:backup-job',0)) AS acquired")).rows[0].acquired;
    if (!acquired) throw new Error('BACKUP_LOCKED');
    await client.query(`INSERT INTO backup_status(singleton, run_id, owner_pid, started_at, outcome, phase)
      VALUES(true, $1, pg_backend_pid(), clock_timestamp(), 'running', 'destination')
      ON CONFLICT(singleton) DO UPDATE SET run_id=$1, owner_pid=pg_backend_pid(),
        started_at=clock_timestamp(), finished_at=NULL, outcome='running', phase='destination'`, [runId]);
    recorded = true;
    const directory = await validateDestination(config);
    phase = 'snapshot';
    await client.query("UPDATE backup_status SET phase=$2 WHERE run_id=$1", [runId, phase]);
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL lock_timeout='10s'");
    await client.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('hirmos:cache-object-lifecycle',0))");
    const snapshot = (await client.query('SELECT pg_export_snapshot() AS id')).rows[0].id;
    const createdAt = new Date().toISOString();
    const name = `hirmos-backup-${createdAt.replaceAll('-', '').replaceAll(':', '').replace('.', '')}-${randomUUID()}`;
    const staging = join(directory, `.pending-${name}`);
    await mkdir(staging, { mode: 0o700 });
    // Never pass credentials in command arguments or print pg_dump stderr.
    await execute('pg_dump', ['--format=custom', '--snapshot', snapshot, '--file', join(staging, 'database.dump')],
      { env: pgEnv, timeout: 30 * 60000, maxBuffer: 1024 * 1024 });
    await chmod(join(staging, 'database.dump'), 0o600);
    await execute('pg_restore', ['--list', join(staging, 'database.dump')], { timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
    const paths = ['database.dump'];
    const lyrics = (await client.query("SELECT DISTINCT object_hash, relative_path FROM cache_entries WHERE namespace='lyrics'")).rows;
    if (lyrics.length && !config.cacheDirectory) throw new Error('BACKUP_LYRICS_ROOT_REQUIRED');
    await mkdir(join(staging, 'lyrics'), { mode: 0o700 });
    for (const lyric of lyrics) {
      if (!/^[a-f0-9]{64}$/.test(lyric.object_hash)
        || lyric.relative_path !== `objects/sha256/${lyric.object_hash.slice(0, 2)}/${lyric.object_hash.slice(2, 4)}/${lyric.object_hash}`) {
        throw new Error('BACKUP_INVALID_LYRICS_REFERENCE');
      }
      const root = resolve(config.cacheDirectory);
      const from = join(root, lyric.relative_path);
      await regularFile(from, root);
      const target = `lyrics/${lyric.object_hash}`;
      await copyFile(from, join(staging, target));
      if (await checksum(join(staging, target)) !== lyric.object_hash) throw new Error('BACKUP_LYRICS_CORRUPT');
      paths.push(target);
    }
    await client.query('COMMIT');
    phase = 'files';
    await client.query("UPDATE backup_status SET phase=$2 WHERE run_id=$1", [runId, phase]);
    await mkdir(join(staging, 'config'), { mode: 0o700 });
    const files = config.files ?? [];
    if (!Array.isArray(files) || files.length > 100) throw new Error('BACKUP_INVALID_CONFIG_FILES');
    for (const [index, file] of files.entries()) {
      if (!isAbsolute(file) || !(await lstat(file)).isFile()) throw new Error('BACKUP_INVALID_CONFIG_FILE');
      const name = basename(file);
      if (!/^[a-zA-Z0-9_.-]+$/.test(name)) throw new Error('BACKUP_INVALID_CONFIG_NAME');
      const target = `config/${String(index).padStart(3, '0')}-${name}`;
      await copyFile(file, join(staging, target));
      await chmod(join(staging, target), 0o600);
      paths.push(target);
    }
    const artifacts = [];
    for (const path of paths) artifacts.push({ path, bytes: (await lstat(join(staging, path))).size,
      sha256: await checksum(join(staging, path)) });
    const manifest = { kind: 'hirmos-backup', version: 1, database, createdAt, encrypted: false,
      release: config.release ?? null, artifacts };
    phase = 'verification';
    await client.query("UPDATE backup_status SET phase=$2 WHERE run_id=$1", [runId, phase]);
    await writeFile(join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx', mode: 0o600 });
    await verifyBackup(staging, database);
    const target = join(directory, name);
    await rename(staging, target);
    published = true;
    const bytes = artifacts.reduce((sum, item) => sum + item.bytes, 0);
    phase = 'retention';
    await client.query(`UPDATE backup_status SET last_success_at=clock_timestamp(), last_snapshot_at=$2,
      last_bytes=$3, last_duration_ms=$4, phase='retention' WHERE run_id=$1`,
      [runId, createdAt, bytes, Math.round(performance.now() - started)]);
    // Rotate only after a new verified backup was published. Unknown files and
    // incomplete backups are never recursively removed by this command.
    const retired = await rotateBackups(directory, database);
    await client.query(`UPDATE backup_status SET outcome='succeeded', phase='complete',
      finished_at=clock_timestamp() WHERE run_id=$1`, [runId]);
    return { name, database, bytes, retired };
  } catch (error) {
    if (recorded) {
      try {
        await client.query('ROLLBACK');
        await client.query(`UPDATE backup_status SET outcome=$2, phase=$3,
          finished_at=clock_timestamp() WHERE run_id=$1`, [runId, published ? 'warning' : 'failed', phase]);
      } catch { /* A lost DB connection leaves an interrupted receipt, never invented success. */ }
    }
    throw error;
  } finally {
    if (connected) await client.end();
  }
}

export async function rotateBackups(directory, database) {
  const backups = [];
  for (const name of await readdir(directory)) {
    if (!backupName.test(name)) continue;
    const manifest = await verifyBackup(join(directory, name), database);
    backups.push({ ...manifest, name });
  }
  const keep = retainedBackups(backups);
  // Preflight every retirement before deleting any artifact. Unexpected files
  // or symlink directories must not leave an otherwise good backup half erased.
  for (const backup of backups) {
    if (keep.has(backup.name)) continue;
    const root = join(directory, backup.name);
    const expected = new Set(['manifest.json', 'database.dump', 'lyrics', 'config']);
    const entries = await readdir(root);
    if (entries.length !== expected.size || entries.some(name => !expected.has(name))) {
      throw new Error('BACKUP_UNEXPECTED_FILE');
    }
    for (const folder of ['lyrics', 'config']) {
      if (!(await lstat(join(root, folder))).isDirectory()) throw new Error('BACKUP_NOT_DIRECTORY');
      const expectedFiles = new Set(backup.artifacts.filter(item => item.path.startsWith(`${folder}/`))
        .map(item => item.path.slice(folder.length + 1)));
      const files = await readdir(join(root, folder));
      if (files.length !== expectedFiles.size || files.some(name => !expectedFiles.has(name))) {
        throw new Error('BACKUP_UNEXPECTED_FILE');
      }
    }
  }
  const retired = [];
  for (const backup of backups) {
    if (keep.has(backup.name)) continue;
    const root = join(directory, backup.name);
    for (const artifact of backup.artifacts) await unlink(join(root, artifact.path));
    await rmdir(join(root, 'lyrics'));
    await rmdir(join(root, 'config'));
    await unlink(join(root, 'manifest.json'));
    await rmdir(root);
    retired.push(backup.name);
  }
  return retired;
}
