import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pg from 'pg';
import { createBackup, verifyBackup, postgresEnvironment } from '../tools/backup/backup.mjs';
import { prepareRestoredDatabase } from '../tools/backup/prepare-restored.mjs';
import { ObjectStore } from '../apps/api/dist/cache/object-store.js';
import { readBackupStatus } from '../apps/api/dist/backup/backup-status.js';
import { SourceCredentialCipher } from '../apps/api/dist/music-source/source-credential-cipher.js';

const execute = promisify(execFile);
const url = new URL(process.env.HIRMOS_TEST_DATABASE_URL ?? '');
assert.ok(['localhost', '127.0.0.1'].includes(url.hostname) && url.pathname === '/hirmos_core_test');
const admin = new pg.Client({ connectionString: url.href }); await admin.connect();
const id = randomUUID().replaceAll('-', '');
const original = `hirmos_backup_test_${id}`;
const restored = `hirmos_restore_test_${id}`;
const working = await mkdtemp(join(tmpdir(), 'hirmos-backup-fixture-'));
const backupMount = process.env.HIRMOS_TEST_BACKUP_MOUNT ?? '/dev/shm';
assert.ok(['/dev/shm', '/tmp'].includes(backupMount));
const destination = join(backupMount, `hirmos-backups-test-${id}`);
let source; let target; const databases = [];
try {
  for (const name of [original, restored]) { await admin.query(`CREATE DATABASE ${name}`); databases.push(name); }
  const sourceUrl = new URL(url); sourceUrl.pathname = `/${original}`;
  source = new pg.Client({ connectionString: sourceUrl.href }); await source.connect();
  for (const file of (await readdir(new URL('../database/migrations/', import.meta.url))).filter(f => f.endsWith('.sql')).sort()) {
    await source.query(await readFile(new URL(`../database/migrations/${file}`, import.meta.url), 'utf8'));
  }
  assert.equal((await readBackupStatus(source)).lastAttempt, null);
  assert.equal((await readBackupStatus(source)).overdue, true);
  await source.query(`INSERT INTO backup_status(run_id,owner_pid,started_at,outcome,phase)
    VALUES($1,pg_backend_pid(),now(),'running','snapshot')`, [randomUUID()]);
  assert.equal((await readBackupStatus(source)).lastAttempt.outcome, 'interrupted');
  // A different advisory lock must not make an interrupted backup look active.
  await source.query("SELECT pg_advisory_lock(hashtextextended('hirmos:unrelated-test-lock',0))");
  assert.equal((await readBackupStatus(source)).lastAttempt.outcome, 'interrupted');
  await source.query("SELECT pg_advisory_lock(hashtextextended('hirmos:backup-job',0))");
  assert.equal((await readBackupStatus(source)).lastAttempt.outcome, 'running');
  await source.query('SELECT pg_advisory_unlock_all()');
  assert.equal((await readBackupStatus(source)).lastAttempt.outcome, 'interrupted');
  console.log('PASS empty receipt and interrupted execution distinguished from exact active job lock');
  const userId=(await source.query("INSERT INTO users(email,display_name,role) VALUES('backup@example.test','Synthetic backup','user') RETURNING id")).rows[0].id;
  const sourceId=(await source.query(`INSERT INTO music_sources(name,adapter_type,base_url,credential_ciphertext,encryption_key_version)
    VALUES('Synthetic','navidrome','http://music.example.test',decode('abcd','hex'),1) RETURNING id`)).rows[0].id;
  const key=randomBytes(32).toString('base64url');
  const credentials={username:'synthetic',password:'synthetic-only'};
  const encrypted=new SourceCredentialCipher(key).encrypt(credentials);
  await source.query('UPDATE music_sources SET credential_ciphertext=$1 WHERE id=$2',[encrypted.ciphertext,sourceId]);
  const deviceId=randomUUID();
  await source.query(`INSERT INTO devices(id,user_id,name,device_type) VALUES($1,$2,'Synthetic device','desktop')`,[deviceId,userId]);
  const sessionId=(await source.query(`INSERT INTO playback_sessions(user_id,status,active_device_id,lease_expires_at,lease_epoch,position_ms)
    VALUES($1,'playing',$2,now()+interval '1 hour',7,42000) RETURNING id`,[userId,deviceId])).rows[0].id;
  const trackId=(await source.query(`INSERT INTO queue_items(playback_session_id,source_id,remote_track_id,ordinal,origin)
    VALUES($1,$2,'synthetic-track',0,'album') RETURNING id`,[sessionId,sourceId])).rows[0].id;
  await source.query('UPDATE playback_sessions SET current_queue_item_id=$1 WHERE id=$2',[trackId,sessionId]);
  await source.query(`INSERT INTO auth_sessions(user_id,token_hash,expires_at) VALUES($1,decode('01','hex'),now()+interval '1 day')`,[userId]);
  await source.query(`INSERT INTO account_invitations(email,token_hash,created_by,expires_at)
    VALUES('invited@example.test',decode('02','hex'),$1,now()+interval '1 day')`,[userId]);
  await source.query(`INSERT INTO password_recovery_tokens(user_id,token_hash,expires_at)
    VALUES($1,decode('03','hex'),now()+interval '1 day')`,[userId]);
  await source.query(`INSERT INTO email_outbox(message_type,recipient,template_data_ciphertext,encryption_key_version,lock_id,locked_at)
    VALUES('recovery','backup@example.test',decode('abcd','hex'),1,$1,now())`,[randomUUID()]);
  const playlistId=(await source.query(`INSERT INTO playlists(user_id,name) VALUES($1,'Synthetic playlist') RETURNING id`,[userId])).rows[0].id;
  await source.query(`INSERT INTO playlist_items(playlist_id,source_id,remote_track_id,ordinal,metadata)
    VALUES($1,$2,'synthetic-track',0,'{}')`,[playlistId,sourceId]);
  await source.query(`INSERT INTO user_favorites(user_id,source_id,entity_type,remote_entity_id) VALUES($1,$2,'track','synthetic-track')`,[userId,sourceId]);
  await source.query(`INSERT INTO user_track_stats(user_id,source_id,remote_track_id,play_starts,listened_ms)
    VALUES($1,$2,'synthetic-track',3,42000)`,[userId,sourceId]);
  await source.query(`INSERT INTO playback_command_receipts(user_id,command_id,request_hash) VALUES($1,$2,'synthetic')`,[userId,randomUUID()]);
  const executionId=randomUUID();
  await source.query(`INSERT INTO offline_listen_executions(user_id,id,source_id,remote_track_id,started_at)
    VALUES($1,$2,$3,'synthetic-track',now())`,[userId,executionId,sourceId]);
  await source.query(`INSERT INTO offline_listen_receipts(user_id,id,execution_id,payload) VALUES($1,$2,$3,'{}')`,[userId,randomUUID(),executionId]);
  await source.query(`INSERT INTO background_jobs(kind,dedupe_key,status,lease_owner,lease_expires_at)
    VALUES('metadata_refresh','synthetic','running','old-worker',now()+interval '1 hour')`);
  const cache = new ObjectStore(join(working, 'cache')); await cache.initialize();
  const lyric = await cache.put(new TextEncoder().encode('Synthetic lyric retained once'));
  await source.query(`INSERT INTO cache_entries(namespace,cache_key,variant,object_hash,relative_path,content_type,byte_length,content_hash)
    VALUES('lyrics','synthetic','plain',$1,$2,'text/plain',$3,$1)`, [lyric.hash, lyric.relativePath, lyric.byteLength]);
  const configFile = join(working, 'runtime.env');
  await writeFile(configFile, `DATA_ENCRYPTION_KEY=${key}\n`,{mode:0o600});
  const config = { directory: destination, mount: backupMount, cacheDirectory: join(working, 'cache'), files: [configFile] };
  const result = await createBackup(config, sourceUrl.href);
  const path = join(destination, result.name);
  const manifest = await verifyBackup(path, original);
  const successful = await readBackupStatus(source);
  assert.equal(successful.lastAttempt.outcome, 'succeeded');
  assert.equal(successful.lastSuccess.bytes, result.bytes);
  assert.ok(successful.lastSuccess.durationMs > 0);
  assert.equal(successful.overdue, false);
  assert.equal(manifest.encrypted, false);
  assert.equal(manifest.artifacts.length, 3);
  assert.equal(await readFile(join(path, `lyrics/${lyric.hash}`), 'utf8'), 'Synthetic lyric retained once');
  console.log('PASS consistent backup with unencrypted configuration, checked lyrics and checksum manifest');
  const targetUrl = new URL(url); targetUrl.pathname = `/${restored}`;
  const pgEnv = postgresEnvironment(targetUrl.href);
  await execute('pg_restore', ['--exit-on-error', '--single-transaction', '--no-owner', '--no-acl', '--dbname', restored, join(path, 'database.dump')],
    { env: pgEnv, timeout: 60000, maxBuffer: 1024 * 1024 });
  target = new pg.Client({ connectionString: targetUrl.href }); await target.connect();
  assert.equal((await target.query('SELECT display_name FROM users')).rows[0].display_name, 'Synthetic backup');
  assert.equal((await target.query('SELECT object_hash FROM cache_entries')).rows[0].object_hash, lyric.hash);
  const restoredKey=(await readFile(join(path,'config/000-runtime.env'),'utf8')).trim().split('=')[1];
  const restoredCredentials=(await target.query('SELECT credential_ciphertext,encryption_key_version FROM music_sources')).rows[0];
  assert.deepEqual(new SourceCredentialCipher(restoredKey).decrypt(restoredCredentials.credential_ciphertext,restoredCredentials.encryption_key_version),credentials);
  const restoredCache=new ObjectStore(join(working,'restored-cache'));await restoredCache.initialize();
  const restoredLyric=await restoredCache.put(await readFile(join(path,`lyrics/${lyric.hash}`)));
  assert.equal(restoredLyric.hash,lyric.hash);assert.equal(restoredLyric.relativePath,lyric.relativePath);
  console.log('PASS backed-up key decrypts source credentials and lyrics reconstruct at their original content address');
  // Snapshot contains an in-progress receipt, but restore must not claim the old job is still running.
  assert.equal((await readBackupStatus(target)).lastAttempt.outcome, 'interrupted');
  console.log('PASS pg_restore into a second isolated database with restored user and lyric reference');
  await assert.rejects(prepareRestoredDatabase(sourceUrl.href, original),/TARGET_NOT_CONFIRMED/);
  await assert.rejects(prepareRestoredDatabase(targetUrl.href, restored),/DATABASE_IN_USE/);
  await target.end();target=null;
  await prepareRestoredDatabase(targetUrl.href,restored);
  target=new pg.Client({connectionString:targetUrl.href});await target.connect();
  const restoredSession=(await target.query('SELECT * FROM playback_sessions')).rows[0];
  assert.equal(restoredSession.status,'paused');assert.equal(restoredSession.active_device_id,null);
  assert.equal(restoredSession.lease_expires_at,null);assert.equal(restoredSession.lease_epoch,'8');
  assert.equal(restoredSession.current_queue_item_id,trackId);assert.equal(restoredSession.position_ms,42000);
  for(const sql of ["SELECT 1 FROM auth_sessions WHERE revoked_at IS NULL",
    "SELECT 1 FROM password_recovery_tokens WHERE consumed_at IS NULL",
    "SELECT 1 FROM account_invitations WHERE revoked_at IS NULL",
    "SELECT 1 FROM email_outbox WHERE sent_at IS NULL AND failed_at IS NULL"]){assert.equal((await target.query(sql)).rowCount,0);}
  for(const table of ['queue_items','playlists','playlist_items','user_favorites','playback_command_receipts','offline_listen_receipts']){
    assert.equal((await target.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n,1);
  }
  assert.equal((await target.query('SELECT listened_ms FROM user_track_stats')).rows[0].listened_ms,'42000');
  assert.equal((await target.query('SELECT status FROM background_jobs')).rows[0].status,'pending');
  assert.equal((await source.query('SELECT revoked_at FROM auth_sessions')).rows[0].revoked_at,null);
  assert.equal((await source.query('SELECT status FROM playback_sessions')).rows[0].status,'playing');
  console.log('PASS isolated preparation revokes old access/mail/leases, preserves queue/position/playlists/favorites/statistics/receipts and leaves source unchanged');
  // Missing schema must roll back earlier revocations, not leave a partly prepared copy.
  await target.query('UPDATE auth_sessions SET revoked_at=NULL');
  await target.query('ALTER TABLE background_jobs RENAME TO background_jobs_test_hidden');
  await target.end();target=null;
  await assert.rejects(prepareRestoredDatabase(targetUrl.href,restored));
  target=new pg.Client({connectionString:targetUrl.href});await target.connect();
  assert.equal((await target.query('SELECT revoked_at FROM auth_sessions')).rows[0].revoked_at,null);
  await target.query('ALTER TABLE background_jobs_test_hidden RENAME TO background_jobs');
  console.log('PASS incompatible restored schema rolls back preparation atomically');
  await source.query("SELECT pg_advisory_lock(hashtextextended('hirmos:backup-job',0))");
  await assert.rejects(createBackup(config, sourceUrl.href), /BACKUP_LOCKED/);
  assert.deepEqual((await readBackupStatus(source)).lastAttempt, successful.lastAttempt);
  await source.query("SELECT pg_advisory_unlock(hashtextextended('hirmos:backup-job',0))");
  console.log('PASS concurrent backup refuses existing PG lock without a persistent lockfile');
  await assert.rejects(createBackup({ ...config, files: [join(working, 'missing.env')] }, sourceUrl.href));
  assert.equal((await verifyBackup(path, original)).database, original);
  assert.equal((await readdir(destination)).filter(name => name.startsWith('hirmos-backup-')).length, 1);
  assert.equal((await readBackupStatus(source)).lastAttempt.outcome, 'failed');
  assert.equal((await readBackupStatus(source)).lastAttempt.phase, 'files');
  assert.deepEqual((await readBackupStatus(source)).lastSuccess, successful.lastSuccess);
  console.log('PASS failed backup stays unpublished and never rotates the previous good copy');
  await assert.rejects(createBackup({ ...config, mount: '/', directory: '/hirmos-backups' }, sourceUrl.href), /UNSAFE_DESTINATION/);
  assert.equal((await readBackupStatus(source)).lastAttempt.phase, 'destination');
  assert.deepEqual((await readBackupStatus(source)).lastSuccess, successful.lastSuccess);
  await source.query("UPDATE backup_status SET last_snapshot_at=clock_timestamp()-interval '37 hours'");
  assert.equal((await readBackupStatus(source)).overdue, true);
  console.log('PASS destination failure preserves success; 36h age is measured from snapshot, not recent attempt');
  // A damaged older manifest blocks retention, but not publication of the new verified copy.
  await writeFile(join(path, 'manifest.json'), 'invalid synthetic manifest');
  await assert.rejects(createBackup(config, sourceUrl.href));
  const warning = await readBackupStatus(source);
  assert.equal(warning.lastAttempt.outcome, 'warning');
  assert.equal(warning.lastAttempt.phase, 'retention');
  assert.equal(warning.overdue, false);
  assert.notEqual(warning.lastSuccess.verifiedAt, successful.lastSuccess.verifiedAt);
  const generations = (await readdir(destination)).filter(name => name.startsWith('hirmos-backup-'));
  assert.equal(generations.length, 2);
  await verifyBackup(join(destination, generations.find(name => name !== result.name)), original);
  console.log('PASS retention error retains verified success, marks warning and keeps generations');
} finally {
  if (source) await source.end(); if (target) await target.end();
  for (const name of databases.reverse()) await admin.query(`DROP DATABASE ${name}`);
  await admin.end();
  await rm(working, { recursive: true, force: true });
  await rm(destination, { recursive: true, force: true });
}
