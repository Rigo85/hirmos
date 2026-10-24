// Explicit, selective maintenance. Dry-run by default; no source configuration
// changes, cache purges, audio downloads, or credentials in output.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { createDatabase } from '../apps/api/dist/db/database.js';
import { MusicSourceRepository } from '../apps/api/dist/music-source/music-source-repository.js';
import { SourceCredentialCipher } from '../apps/api/dist/music-source/source-credential-cipher.js';
import { DefaultMusicSourceAdapterFactory } from '../apps/api/dist/music-source/music-source-adapter-factory.js';
import { CacheRepository } from '../apps/api/dist/cache/cache-repository.js';
import { ImageCacheService } from '../apps/api/dist/cache/image-cache-service.js';
import { KNOWN_IMAGE_PLACEHOLDERS } from '../apps/api/dist/cache/image-refresh-policy.js';
import { ObjectStore } from '../apps/api/dist/cache/object-store.js';

const { values } = parseArgs({ options: {
  artist: { type: 'string' }, apply: { type: 'boolean', default: false },
  'expected-hash': { type: 'string' }, preview: { type: 'string' },
} });
assert.ok(values.artist, '--artist must be the exact source artist ID');
const { DATABASE_URL, DATA_ENCRYPTION_KEY, HIRMOS_CACHE_DIR } = process.env;
assert.ok(DATABASE_URL && DATA_ENCRYPTION_KEY && HIRMOS_CACHE_DIR, 'Database, encryption key and cache directory must be configured');
assert.match(new URL(DATABASE_URL).pathname, /^\/hirmos(?:[_-][a-zA-Z0-9_-]+)?$/, 'Only a Hirmos database is allowed');
if (values.apply) assert.match(values['expected-hash'] ?? '', /^[0-9a-f]{64}$/, 'Review the preview and supply --expected-hash before applying');
const db = createDatabase(DATABASE_URL);
try {
  const source = await new MusicSourceRepository(db).current();
  assert.ok(source, 'No active source');
  const result = await db.query(`SELECT name, cover_art_id FROM catalog_artists
    WHERE source_id=$1 AND remote_artist_id=$2 AND missing_since IS NULL`, [source.id, values.artist]);
  const artist = result.rows[0];
  assert.ok(artist?.cover_art_id, 'Artist is not present or has no cover reference');
  const adapter = new DefaultMusicSourceAdapterFactory().create({ adapterType: source.adapterType,
    baseUrl: new URL(source.baseUrl), ...new SourceCredentialCipher(DATA_ENCRYPTION_KEY)
      .decrypt(source.credentialCiphertext, source.encryptionKeyVersion) });
  const media = await adapter.getCoverArt(artist.cover_art_id, 320, AbortSignal.timeout(30000));
  assert.ok(media.contentType?.startsWith('image/'), 'Source did not return an image');
  const reader = media.body.getReader(); const chunks = []; let length = 0;
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      length += part.value.length; assert.ok(length <= 12 * 1024 * 1024, 'Image exceeds limit');
      chunks.push(part.value);
    }
  } finally { await reader.cancel().catch(() => undefined); }
  const bytes = Buffer.concat(chunks);
  assert.ok(bytes.length, 'Empty image');
  const hash = createHash('sha256').update(bytes).digest('hex');
  assert.ok(!KNOWN_IMAGE_PLACEHOLDERS.has(hash), 'Source still returns a known placeholder');
  if (values.preview) await writeFile(values.preview, bytes, { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ artist: artist.name, cover: artist.cover_art_id, hash, bytes: bytes.length, apply: values.apply }));
  if (values.apply) {
    assert.equal(hash, values['expected-hash'], 'Source changed since preview; review again');
    const cached = await db.query(`SELECT DISTINCT variant FROM cache_entries WHERE namespace='image'
      AND source_id=$1 AND remote_entity_id=$2`, [source.id, artist.cover_art_id]);
    const sizes = [...new Set([320, ...cached.rows.map(row => Number(row.variant))])].filter(size => [128,320,640].includes(size));
    const cache = new ImageCacheService(new CacheRepository(db), new ObjectStore(HIRMOS_CACHE_DIR), 1,
      { observe: imageCache => console.log(JSON.stringify({ imageCache })) });
    await cache.initialize();
    for (const size of sizes) {
      await cache.refresh({ sourceId: source.id, remoteId: artist.cover_art_id, size,
        load: signal => size === 320 ? Promise.resolve({ ...media, body: new Response(bytes).body })
          : adapter.getCoverArt(artist.cover_art_id, size, signal) });
    }
    console.log(JSON.stringify({ refreshedSizes: sizes }));
  }
} finally { await db.close(); }
