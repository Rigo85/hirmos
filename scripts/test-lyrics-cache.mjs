// Isolated PostgreSQL regression; never connects to a production database.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { createDatabase } from '../apps/api/dist/db/database.js';
import { LyricsRepository } from '../apps/api/dist/lyrics/lyrics-repository.js';

const url = new URL(process.env.HIRMOS_TEST_DATABASE_URL ?? '');
assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname) && url.pathname === '/hirmos_core_test');
const admin = new pg.Client({ connectionString: url.href });
await admin.connect();
const schema = `hirmos_lyrics_${randomUUID().replaceAll('-', '')}`;
await admin.query(`CREATE SCHEMA ${schema}`);
url.searchParams.set('options', `-c search_path=${schema} -c statement_timeout=10000`);
const db = createDatabase(url.href);
try {
  for (const file of (await readdir(new URL('../database/migrations/', import.meta.url)))
    .filter(file => file.endsWith('.sql')).sort()) {
    await db.query(await readFile(new URL(`../database/migrations/${file}`, import.meta.url), 'utf8'));
  }
  const sourceId = (await db.query(`INSERT INTO music_sources
    (name,adapter_type,base_url,credential_ciphertext,encryption_key_version,enabled)
    VALUES ('Fixture','navidrome','https://music.example.test',decode('00','hex'),1,true) RETURNING id`)).rows[0].id;
  const repo = new LyricsRepository(db);
  const key = { sourceId, remoteTrackId: 'synthetic', provider: 'lrclib', fingerprint: 'same-metadata' };
  const next = { ...key, negativeCacheVersion: 'lrclib-lookup-v2' };
  await repo.put({ ...key, document: null });
  assert.equal(await repo.get(key), null);
  assert.equal(await repo.get(next), undefined);
  assert.equal((await db.query('SELECT count(*) FROM lyrics_cache')).rows[0].count, '1');
  console.log('PASS old negative bypassed without deletion');
  await repo.put({ ...key, document: null, parserVersion: next.negativeCacheVersion });
  assert.equal(await repo.get(next), null);
  console.log('PASS new negative reused');
  const document = { displayArtist: 'Synthetic', displayTitle: 'Song', language: null, synced: true,
    lines: [{ startMs: 1000, text: 'Synthetic line' }] };
  await repo.put({ ...key, document, parserVersion: 'lrclib-json-v1' });
  await db.query("UPDATE lyrics_cache SET expires_at=now()-interval '1 day'");
  assert.deepEqual(await repo.get(next), [document]);
  assert.deepEqual(await repo.get({ ...key, negativeCacheVersion: 'future-version' }), [document]);
  console.log('PASS positive survives expiry and strategy changes');
  await Promise.all([
    repo.put({ ...key, document: null, parserVersion: next.negativeCacheVersion }),
    repo.put({ ...key, document: { ...document, synced: false, lines: [{ startMs: null, text: 'Plain' }] } }),
  ]);
  assert.deepEqual(await repo.get(next), [document]);
  console.log('PASS concurrent negatives and inferior quality cannot overwrite a positive');
  assert.equal(await repo.get({ ...next, fingerprint: 'different-recording' }), undefined);
  assert.equal(await repo.get({ ...next, provider: 'amll-ttml' }), undefined);
  console.log('PASS recording fingerprints and providers remain isolated');
} finally {
  await db.close();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
}
