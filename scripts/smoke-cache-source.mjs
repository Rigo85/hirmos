import assert from 'node:assert/strict';
import { createDatabase } from '../apps/api/dist/db/database.js';
import { CacheRepository } from '../apps/api/dist/cache/cache-repository.js';
import { ImageCacheService } from '../apps/api/dist/cache/image-cache-service.js';
import { ObjectStore } from '../apps/api/dist/cache/object-store.js';
import { DefaultMusicSourceAdapterFactory } from '../apps/api/dist/music-source/music-source-adapter-factory.js';
import { MusicSourceRepository } from '../apps/api/dist/music-source/music-source-repository.js';
import { SourceCredentialCipher } from '../apps/api/dist/music-source/source-credential-cipher.js';

const { DATABASE_URL: databaseUrl, DATA_ENCRYPTION_KEY: encryptionKey, HIRMOS_CACHE_DIR: cacheDir } = process.env;
if (!databaseUrl || !encryptionKey || !cacheDir) {
  throw new Error('DATABASE_URL, DATA_ENCRYPTION_KEY and HIRMOS_CACHE_DIR are required');
}

const db = createDatabase(databaseUrl);
try {
  const source = await new MusicSourceRepository(db).current();
  assert.ok(source, 'An enabled music source is required');
  const cover = await db.query(
    `SELECT cover_art_id FROM catalog_albums
      WHERE source_id = $1 AND cover_art_id IS NOT NULL AND missing_since IS NULL
      ORDER BY remote_album_id LIMIT 1`,
    [source.id],
  );
  const coverArtId = cover.rows[0]?.cover_art_id;
  assert.ok(coverArtId, 'A mirrored cover is required');
  const credentials = new SourceCredentialCipher(encryptionKey).decrypt(
    source.credentialCiphertext, source.encryptionKeyVersion,
  );
  const adapter = new DefaultMusicSourceAdapterFactory().create({
    adapterType: source.adapterType,
    baseUrl: new URL(source.baseUrl),
    ...credentials,
  });
  const cache = new ImageCacheService(
    new CacheRepository(db), new ObjectStore(cacheDir), 1,
  );
  await cache.initialize();
  let upstreamCalls = 0;
  const load = () => {
    upstreamCalls += 1;
    return adapter.getCoverArt(coverArtId, 128, AbortSignal.timeout(15_000));
  };
  const first = await cache.get({ sourceId: source.id, remoteId: coverArtId, size: 128, load });
  const second = await cache.get({ sourceId: source.id, remoteId: coverArtId, size: 128, load });
  const [firstBytes, secondBytes] = await Promise.all([
    new Response(first.body).arrayBuffer(), new Response(second.body).arrayBuffer(),
  ]);
  assert.equal(upstreamCalls, 1);
  assert.equal(firstBytes.byteLength, secondBytes.byteLength);
  assert.ok(firstBytes.byteLength > 0);
  console.log(JSON.stringify({ upstreamCalls, bytes: firstBytes.byteLength, contentType: first.contentType }));
} finally {
  await db.close();
}
