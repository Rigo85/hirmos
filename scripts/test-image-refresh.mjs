import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { createDatabase } from '../apps/api/dist/db/database.js';
import { CacheRepository } from '../apps/api/dist/cache/cache-repository.js';
import { ImageWarmRepository } from '../apps/api/dist/cache/image-warm-repository.js';
import { ImageCacheService, imageKey } from '../apps/api/dist/cache/image-cache-service.js';
import { KNOWN_IMAGE_PLACEHOLDERS } from '../apps/api/dist/cache/image-refresh-policy.js';
import { ObjectStore } from '../apps/api/dist/cache/object-store.js';

const url = new URL(process.env.HIRMOS_TEST_DATABASE_URL ?? '');
assert.ok(['localhost','127.0.0.1'].includes(url.hostname) && url.pathname === '/hirmos_core_test');
const admin = new pg.Client({ connectionString: url.href }); await admin.connect();
const schema = `hirmos_image_${randomUUID().replaceAll('-', '')}`;
await admin.query(`CREATE SCHEMA ${schema}`);
url.searchParams.set('options', `-c search_path=${schema} -c statement_timeout=10000`);
const db = createDatabase(url.href);
const root = await mkdtemp(join(tmpdir(), 'hirmos-image-pg-'));
let checks = 0;
const pass = name => { checks++; console.log(`PASS ${name}`); };
try {
  for (const file of (await readdir(new URL('../database/migrations/', import.meta.url))).filter(f => f.endsWith('.sql')).sort()) {
    await db.query(await readFile(new URL(`../database/migrations/${file}`, import.meta.url), 'utf8'));
  }
  const source = (await db.query(`INSERT INTO music_sources(name,adapter_type,base_url,credential_ciphertext,encryption_key_version,enabled)
    VALUES('Synthetic','navidrome','https://music.example.test',decode('00','hex'),1,true) RETURNING id`)).rows[0].id;
  await db.query(`INSERT INTO catalog_albums(source_id,remote_album_id,name,artist_name,cover_art_id)
    VALUES($1,'album','Test','Synthetic','cover')`, [source]);
  const repository = new CacheRepository(db), queue = new ImageWarmRepository(db), store = new ObjectStore(root);
  await store.initialize();
  const cache = new ImageCacheService(repository, store, 1, { random: () => 0 });
  const media = bytes => ({ status:200, contentType:'image/png', body:new Response(bytes).body });
  let content = new Uint8Array([1,2,3]); let calls = 0;
  const input = { sourceId:source,remoteId:'cover',size:320,load:async()=>{calls++;return media(content);} };
  const key = imageKey(source, 'cover', 320);
  assert.equal(await queue.enqueueCatalogImages(), 1);
  const job = await queue.claim('fixture'); assert.ok(job);
  await cache.warm(input);
  await queue.enqueueCatalogImages();
  assert.equal((await db.query('SELECT status FROM background_jobs WHERE id=$1',[job.id])).rows[0].status,'running');
  await queue.complete(job.id, 'fixture');
  assert.equal(await queue.enqueueCatalogImages(), 0);
  pass('migration, cold warm and fresh-cache scheduling; enqueue never cancels a running lease');

  content = new Uint8Array([4,5,6]); await cache.refresh(input);
  assert.equal(calls,2);
  const fresh = await repository.get('image',key);
  assert.equal(fresh.contentHash,createHash('sha256').update(content).digest('hex'));
  pass('explicit refresh replaces fresh bytes without purging the previous object');

  const blocked = await repository.publishImage(key,'0',()=>{throw Error('Late write executed');});
  assert.equal(blocked.published,false);
  const before = await repository.get('image',key);
  const contenders = await Promise.all([1,2].map(()=>repository.publishImage(key,before.revision,
    locked=>locked.recordImageAttempt(key,'image',0,1000))));
  assert.equal(contenders.filter(result=>result.published).length,1);
  pass('real PG publication lock and revision fence reject stale and competing writers');

  content = new Uint8Array([99,88]);
  KNOWN_IMAGE_PLACEHOLDERS.add(createHash('sha256').update(content).digest('hex'));
  await cache.refresh(input);
  let row = await repository.get('image',key);
  assert.equal(row.contentHash,fresh.contentHash); assert.equal(row.imageLastResult,'placeholder');
  assert.equal(row.fetchedAt.valueOf(),fresh.fetchedAt.valueOf());
  assert.ok(row.nextRefreshAt.valueOf()>Date.now()+86300000);
  assert.equal(await queue.enqueueCatalogImages(),0);
  await db.query("UPDATE cache_entries SET next_refresh_at=now()-interval '1 second' WHERE cache_key=$1",[key]);
  assert.equal(await queue.enqueueCatalogImages(),1);
  pass('HTTP 200 placeholder preserves photo and successful date; worker uses the shorter persisted deadline');

  // A second process refreshes while the original request is still pending.
  let finish; const started = new Promise(resolve => {
    input.load = async () => { resolve(); return new Promise(done => { finish=done; }); };
  });
  const late = cache.refresh(input); await started;
  const second = new ImageCacheService(new CacheRepository(db),store,1);
  await second.refresh({...input,load:async()=>media(new Uint8Array([7,8,9]))});
  const winner = await repository.get('image',key);
  finish(media(new Uint8Array([3,2,1]))); await late;
  row = await repository.get('image',key); assert.equal(row.contentHash,winner.contentHash);
  assert.equal(row.revision,winner.revision);
  pass('late network result from a different service instance cannot overwrite the winner');
  console.log(`${checks} PostgreSQL image refresh checks passed`);
} finally {
  await db.close(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
  await rm(root,{recursive:true,force:true});
}
