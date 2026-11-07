import sharp from 'sharp';
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
  const photo = async color => sharp({create:{width:2,height:2,channels:3,background:color}}).png().toBuffer();
  let content = await photo('red'); let calls = 0;
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

  content = await photo('blue'); await cache.refresh(input);
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

  content = await readFile(new URL('../apps/api/test/fixtures/images/navidrome-artist-placeholder.webp', import.meta.url));
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
  await second.refresh({...input,load:async()=>media(await photo('green'))});
  const winner = await repository.get('image',key);
  finish(media(await photo('orange'))); await late;
  row = await repository.get('image',key); assert.equal(row.contentHash,winner.contentHash);
  assert.equal(row.revision,winner.revision);
  pass('late network result from a different service instance cannot overwrite the winner');
  assert.ok(row.previousImage);
  const priorHash = row.previousImage.contentHash;
  const expiry = row.previousImageExpiresAt.valueOf();
  await second.refresh({...input,load:async()=>media(await photo('green'))});
  row = await repository.get('image',key);
  assert.equal(row.previousImage.contentHash,priorHash);
  assert.equal(row.previousImageExpiresAt.valueOf(),expiry);
  assert.ok((await repository.referencedHashes()).has(priorHash));
  pass('one durable prior version; unchanged content never rotates or extends it');

  const restarted = new ImageCacheService(new CacheRepository(db),new ObjectStore(root));
  assert.equal(await restarted.restorePrevious(input,'0'.repeat(64)),false);
  assert.equal(await restarted.restorePrevious(input,row.contentHash),true);
  await assert.rejects(()=>restarted.refresh({...input,load:async()=>media(await photo('green'))}),/temporarily rejected/);
  row = await repository.get('image',key);
  assert.equal(row.contentHash,priorHash);
  assert.equal(row.previousImage,null);
  pass('restart-safe guarded rollback and persisted rejection prevent immediate relapse');

  await restarted.warm({...input,remoteId:'shared-photo',load:async()=>media(await photo('blue'))});
  const shared=await repository.get('image',imageKey(source,'shared-photo',320));
  assert.equal(shared.contentHash,row.contentHash);
  assert.equal((await repository.get('image',key)).contentHash,row.contentHash);
  pass('small legitimate photos may be shared by distinct cache keys');

  // Reapply just the selective migration UPDATE as a repair: known placeholders
  // are awakened once; unrelated entries and already classified absences survive.
  const migration = await readFile(new URL('../database/migrations/0024_image_previous_version.sql',import.meta.url),'utf8');
  const repair = migration.slice(migration.indexOf('UPDATE cache_entries'));
  const poisoned = await store.put(content);
  await repository.withObjectMutation(r=>r.put({namespace:'image',key:'poisoned',sourceId:source,
    remoteEntityId:'poisoned',variant:'320',objectHash:poisoned.hash,relativePath:poisoned.relativePath,
    contentType:'image/webp',byteLength:poisoned.byteLength}));
  await db.query("UPDATE cache_entries SET image_last_result='image',next_refresh_at=now()+interval '30 days' WHERE cache_key='poisoned'");
  assert.equal((await db.query(repair)).rowCount,1);
  assert.equal((await db.query(repair)).rowCount,0);
  assert.ok((await repository.get('image','poisoned')).nextRefreshAt.valueOf()<=Date.now());
  assert.equal((await repository.get('image',key)).contentHash,priorHash);
  pass('selective repair is idempotent and leaves recovered photos untouched');
  console.log(`${checks} PostgreSQL image refresh checks passed`);
} finally {
  await db.close(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
  await rm(root,{recursive:true,force:true});
}
