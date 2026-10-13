// Destructive fixtures are restricted to a fresh schema in the local test DB.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { createDatabase } from '../apps/api/dist/db/database.js';
import { CacheRepository } from '../apps/api/dist/cache/cache-repository.js';
import { ObjectStore } from '../apps/api/dist/cache/object-store.js';
import { CacheMaintenanceWorker } from '../apps/api/dist/cache/cache-maintenance-worker.js';
import { ImageCacheService } from '../apps/api/dist/cache/image-cache-service.js';

const url = new URL(process.env.HIRMOS_TEST_DATABASE_URL ?? '');
assert.ok(['localhost', '127.0.0.1'].includes(url.hostname) && url.pathname === '/hirmos_core_test');
const admin = new pg.Client({ connectionString: url.href });
await admin.connect();
const schema = `hirmos_cache_gc_${randomUUID().replaceAll('-', '')}`;
await admin.query(`CREATE SCHEMA ${schema}`);
url.searchParams.set('options', `-c search_path=${schema} -c statement_timeout=10000`);
const db = createDatabase(url.href);
const root = await mkdtemp(join(tmpdir(), 'hirmos-cache-lifecycle-'));
let count = 0;
const pass = message => { count++; console.log(`PASS ${message}`); };
try {
  for (const file of (await readdir(new URL('../database/migrations/', import.meta.url))).filter(f => f.endsWith('.sql')).sort()) {
    await db.query(await readFile(new URL(`../database/migrations/${file}`, import.meta.url), 'utf8'));
  }
  const repo = new CacheRepository(db);
  const store = new ObjectStore(root);
  await store.initialize();
  const source = (await db.query(`INSERT INTO music_sources(name,adapter_type,base_url,credential_ciphertext,encryption_key_version,enabled)
    VALUES('Synthetic','navidrome','https://music.example.test',decode('00','hex'),1,true) RETURNING id`)).rows[0].id;
  const put = (object, key, namespace = 'image') => ({ namespace, key, sourceId: source,
    remoteEntityId: key, variant: '320', objectHash: object.hash, relativePath: object.relativePath,
    contentType: 'image/png', byteLength: object.byteLength });
  const reports = []; const warnings = [];
  const logger = { info: data => reports.push(data), warn: data => warnings.push(data) };
  const worker = new CacheMaintenanceWorker(repo, store, logger, 100000);
  const run = async () => { await worker.run(); assert.equal(warnings.length, 0); };
  const age = () => db.query("UPDATE cache_object_gc SET first_unreferenced_at=now()-interval '8 days'");
  const exists = path => stat(join(root, path)).then(() => true, e => { if (e.code === 'ENOENT') return false; throw e; });
  const cache = new ImageCacheService(repo, store, 1);
  let data = new Uint8Array([1, 2, 3]);
  const load = async () => ({ status: 200, contentType: 'image/png',
    body: new ReadableStream({ start(controller) { controller.enqueue(data); controller.close(); } }) });
  await cache.warm({ sourceId: source, remoteId: 'cover', size: 320, load });
  const old = (await db.query('SELECT * FROM cache_entries')).rows[0];
  await db.query("UPDATE cache_entries SET fetched_at=now()-interval '31 days'");
  data = new Uint8Array([4, 5, 6, 7]);
  await cache.warm({ sourceId: source, remoteId: 'cover', size: 320, load });
  await run();
  assert.equal(reports.at(-1).cacheBytes, 7);
  assert.equal(await repo.physicalByteLength(), 4);
  assert.equal(await exists(old.relative_path), true);
  pass('replacement counts actual bytes; first orphan observation starts a full grace period');

  await age(); await run();
  assert.equal(await exists(old.relative_path), false);
  assert.equal(reports.at(-1).cacheBytes, 4);
  assert.equal((await db.query('SELECT count(*) FROM cache_object_gc')).rows[0].count, '0');
  pass('expired unreferenced cover is removed even below quota, with tracking cleared');

  const orphan = await store.put(new Uint8Array([8, 8]));
  await run(); await age();
  await repo.withObjectMutation(locked => locked.put(put(orphan, 'returned')));
  assert.equal((await db.query('SELECT count(*) FROM cache_object_gc')).rows[0].count, '0');
  await run(); assert.equal(await exists(orphan.relativePath), true);
  pass('republication cancels orphan status and protects the object');

  const left = await store.put(new Uint8Array([9, 9]));
  let release; let ready;
  const pending = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { ready = resolve; });
  const publisher = repo.withObjectMutation(async locked => {
    ready(); await pending; await locked.put(put(left, 'inflight'));
  });
  await started;
  const exclusiveAvailable = await db.transaction(async tx => (await tx.query(
    "SELECT pg_try_advisory_xact_lock(hashtextextended('hirmos:cache-object-lifecycle',0)) AS acquired")).rows[0].acquired);
  assert.equal(exclusiveAvailable, false);
  const collected = repo.withMaintenance(async locked => {
    assert.equal(await locked.orphanEligible(left.hash, 0), false);
  });
  release(); await publisher; await collected;
  assert.equal(await exists(left.relativePath), true);
  pass('PG lifecycle lock fences GC against an in-flight publication and rechecks references');

  const same = await store.put(new Uint8Array([10, 10]));
  await repo.withObjectMutation(async locked => {
    await locked.put(put(same, 'shared-image')); await locked.put(put(same, 'shared-lyrics', 'lyrics'));
  });
  await repo.withMaintenance(async locked => {
    assert.equal(await locked.removeEntry('image', 'shared-image', same.hash), false);
    assert.equal(await locked.orphanEligible(same.hash, 0), false);
    assert.equal(await locked.removeEntry('lyrics', 'shared-lyrics', same.hash), false);
  });
  pass('shared content and lyrics are never deleted by image eviction');

  const newBytes = await store.put(new Uint8Array([11, 11]));
  await repo.withObjectMutation(locked => locked.put(put(newBytes, 'returned')));
  await repo.withMaintenance(async locked => {
    assert.equal(await locked.removeEntry('image', 'returned', orphan.hash), false);
  });
  assert.equal((await repo.get('image', 'returned')).contentHash, newBytes.hash);
  pass('stale eviction candidate cannot remove a replaced entry');

  await db.query("UPDATE cache_entries SET protected_until=now()+interval '1 day' WHERE cache_key='returned'");
  await repo.withMaintenance(async locked => {
    assert.equal(await locked.removeEntry('image', 'returned', newBytes.hash), false);
  });
  pass('protection is rechecked inside the eviction transaction');

  await writeFile(join(root, 'tmp', 'abandoned.part'), '12345');
  await run(); assert.equal(reports.at(-1).untrackedBytes, 5);
  assert.equal(await exists('tmp/abandoned.part'), true);
  pass('temporary bytes count against disk use but are not blindly deleted');

  const lowQuota = new CacheMaintenanceWorker(repo, store, logger, 1);
  await lowQuota.run(); assert.equal(warnings.length, 0);
  assert.equal(await exists(same.relativePath), true);
  assert.equal(await exists(newBytes.relativePath), true);
  assert.equal(reports.at(-1).aboveQuota, true);
  pass('quota pressure cannot delete protected bytes and is reported honestly');
  console.log(`${count} cache lifecycle groups passed`);
} finally {
  await db.close();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
  await rm(root, { recursive: true, force: true });
}
