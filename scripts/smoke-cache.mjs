import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase } from '../apps/api/dist/db/database.js';
import { CatalogRepository } from '../apps/api/dist/activity/catalog-repository.js';
import { CacheRepository } from '../apps/api/dist/cache/cache-repository.js';
import { LyricsObjectCache } from '../apps/api/dist/cache/lyrics-object-cache.js';
import { ObjectStore } from '../apps/api/dist/cache/object-store.js';
import { LyricsRepository } from '../apps/api/dist/lyrics/lyrics-repository.js';
import { ImageWarmRepository } from '../apps/api/dist/cache/image-warm-repository.js';
import { MetadataWarmRepository } from '../apps/api/dist/cache/metadata-warm-repository.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const db = createDatabase(databaseUrl);
const cacheDirectory = await mkdtemp(join(tmpdir(), 'hirmos-cache-smoke-'));
let sourceId;
try {
  const source = await db.query(
    `INSERT INTO music_sources
       (name, adapter_type, base_url, credential_ciphertext, encryption_key_version, enabled)
     VALUES ('Smoke library', 'navidrome', 'http://music.example.test', $1, 1, true)
     RETURNING id`,
    [Buffer.from('smoke-only')],
  );
  sourceId = source.rows[0].id;

  const catalog = new CatalogRepository(db);
  const run = await catalog.beginSync(sourceId);
  await catalog.observeArtists(sourceId, [{
    id: 'artist-1', name: 'Smoke Artist', coverArtId: 'cover-1',
    albumCount: 1, favorite: false, musicBrainzId: null,
  }]);
  await catalog.observeAlbums(sourceId, [{
    id: 'album-1', name: 'Smoke Album', artist: 'Smoke Artist', artistId: 'artist-1',
    coverArtId: 'cover-1', songCount: 1, durationMs: 180_000, year: 2026,
    genre: 'Rock', genres: ['Rock'], musicBrainzId: null, favorite: false,
    playCount: null, lastPlayedAt: null, createdAt: '2026-01-01T00:00:00.000Z',
  }]);
  await catalog.observeTracks(sourceId, [{
    id: 'track-1', title: 'Smoke Song', artist: 'Smoke Artist', artistId: 'artist-1',
    album: 'Smoke Album', albumId: 'album-1', durationMs: 180_000,
    coverArtId: 'cover-1', year: 2026, genres: ['Rock'], musicBrainzId: null,
    favorite: false, trackNumber: 1, discNumber: 1, bitRate: 1000, bitDepth: 24,
    samplingRate: 96_000, channelCount: 2, bpm: 120, replayGain: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  }]);
  await catalog.finishSync({
    id: run.id, sourceId, startedAt: run.startedAt, artists: 1, albums: 1, tracks: 1,
  });
  assert.equal(await catalog.isReady(sourceId), true);
  const stats = await catalog.stats(sourceId);
  assert.deepEqual(
    { artists: stats.artists, albums: stats.albums, tracks: stats.tracks, genres: stats.genres },
    { artists: 1, albums: 1, tracks: 1, genres: 1 },
  );
  assert.ok(stats.syncedAt instanceof Date);
  assert.equal((await catalog.search(sourceId, 'Smoke', 0)).tracks.length, 1);
  assert.deepEqual(await catalog.listGenres(sourceId), [{ name: 'Rock', albumCount: 1, songCount: 1 }]);
  const albumDetail = await catalog.albumDetail(sourceId, 'album-1');
  assert.equal(albumDetail?.tracks[0]?.title, 'Smoke Song');
  await catalog.observeArtistDetail(sourceId, {
    id: 'artist-1', name: 'Smoke Artist', coverArtId: 'cover-1', albumCount: 1,
    favorite: false, musicBrainzId: null, albums: albumDetail ? [albumDetail] : [],
    biography: 'Cached biography', externalUrl: 'https://example.test/artist',
    similarArtists: [{
      id: 'related-not-in-library', name: 'External Related Artist', coverArtId: 'related-cover',
      albumCount: 0, favorite: false, musicBrainzId: null,
    }], topTracks: albumDetail?.tracks ?? [],
  });
  assert.equal((await catalog.artistDetail(sourceId, 'artist-1'))?.detail.biography, 'Cached biography');
  await catalog.observeArtistDetail(sourceId, {
    id: 'artist-1', name: 'Smoke Artist', coverArtId: 'cover-1', albumCount: 1,
    favorite: false, musicBrainzId: null, albums: albumDetail ? [albumDetail] : [],
    biography: 'Updated biography', externalUrl: 'https://example.test/artist-v2',
    similarArtists: [], topTracks: albumDetail?.tracks ?? [],
    externalInfoAvailable: true, topTracksAvailable: true,
  });
  const updatedArtist = await catalog.artistDetail(sourceId, 'artist-1');
  assert.equal(updatedArtist?.detail.biography, 'Updated biography');
  assert.equal(updatedArtist?.detail.externalUrl, 'https://example.test/artist-v2');
  assert.equal((await catalog.stats(sourceId)).artists, 1);
  await catalog.observeArtistDetail(sourceId, {
    id: 'artist-1', name: 'Smoke Artist', coverArtId: 'cover-1', albumCount: 1,
    favorite: false, musicBrainzId: null, albums: albumDetail ? [albumDetail] : [],
    biography: null, externalUrl: null, similarArtists: [], topTracks: [],
    externalInfoAvailable: false, topTracksAvailable: false,
  });
  const preservedArtist = await catalog.artistDetail(sourceId, 'artist-1');
  assert.equal(preservedArtist?.detail.biography, 'Updated biography');
  assert.equal(preservedArtist?.detail.externalUrl, 'https://example.test/artist-v2');
  assert.equal(preservedArtist?.fetchedAt.valueOf(), updatedArtist?.fetchedAt.valueOf());

  const imageWarm = new ImageWarmRepository(db);
  assert.equal(await imageWarm.enqueueCatalogImages(320), 1);
  const imageJob = await imageWarm.claim('smoke-image-worker');
  assert.deepEqual(imageJob && {
    sourceId: imageJob.sourceId, remoteId: imageJob.remoteId, size: imageJob.size,
  }, { sourceId, remoteId: 'cover-1', size: 320 });
  await imageWarm.complete(imageJob.id, 'smoke-image-worker');

  const metadataWarm = new MetadataWarmRepository(db);
  assert.equal(await metadataWarm.enqueueStaleArtists(), 1);
  const metadataJob = await metadataWarm.claim('smoke-metadata-worker');
  assert.deepEqual(metadataJob && {
    sourceId: metadataJob.sourceId, remoteArtistId: metadataJob.remoteArtistId,
  }, { sourceId, remoteArtistId: 'artist-1' });
  await metadataWarm.complete(metadataJob.id, 'smoke-metadata-worker');

  const store = new ObjectStore(cacheDirectory);
  await store.initialize();
  const cache = new CacheRepository(db);
  const lyricsObjects = new LyricsObjectCache(cache, store);
  const lyrics = {
    displayArtist: 'Smoke Artist', displayTitle: 'Smoke Song', language: 'en',
    synced: true, lines: [{ startMs: 1000, text: 'Smoke line' }],
  };
  const raw = await lyricsObjects.put({
    sourceId, remoteTrackId: 'track-1', provider: 'lrclib', fingerprint: 'fingerprint-1',
    raw: { content: '[00:01.00]Smoke line', contentType: 'application/x-lrc', parserVersion: 'lrc-v1' },
    normalized: lyrics,
  });
  const lyricsRepository = new LyricsRepository(db);
  await lyricsRepository.put({
    sourceId, remoteTrackId: 'track-1', provider: 'lrclib', fingerprint: 'fingerprint-1',
    rawObjectKey: raw.key, parserVersion: raw.parserVersion, document: lyrics,
  });
  assert.deepEqual(await lyricsRepository.get({
    sourceId, remoteTrackId: 'track-1', provider: 'lrclib', fingerprint: 'fingerprint-1',
  }), [lyrics]);
  assert.ok(await cache.physicalByteLength() > 0);
  const image = await store.put(new Uint8Array([1, 2, 3, 4]));
  await cache.put({
    namespace: 'image', key: 'smoke-cover-320', sourceId, entityType: 'album',
    remoteEntityId: 'cover-1', variant: '320', objectHash: image.hash,
    relativePath: image.relativePath, contentType: 'image/webp', byteLength: image.byteLength,
  });
  assert.equal((await cache.evictionCandidates(10)).some((item) =>
    item.key === 'smoke-cover-320'), true);

  const firstMissingRun = await catalog.beginSync(sourceId);
  await catalog.finishSync({
    id: firstMissingRun.id, sourceId, startedAt: firstMissingRun.startedAt,
    artists: 0, albums: 0, tracks: 0,
  });
  assert.equal((await catalog.listTracks(sourceId, 10, 0)).length, 1);
  const confirmedMissingRun = await catalog.beginSync(sourceId);
  await catalog.finishSync({
    id: confirmedMissingRun.id, sourceId, startedAt: confirmedMissingRun.startedAt,
    artists: 0, albums: 0, tracks: 0,
  });
  assert.equal((await catalog.listTracks(sourceId, 10, 0)).length, 0);

  await db.query(
    `UPDATE background_jobs SET status = 'pending', available_at = now()
      WHERE kind = 'metadata_refresh'`,
  );
  assert.equal(await metadataWarm.enqueueStaleArtists(), 0);
  assert.equal(await metadataWarm.claim('inactive-metadata-worker'), null);
  assert.equal((await metadataWarm.stats()).pending, 0);

  await db.query(
    `INSERT INTO background_jobs (kind, dedupe_key, payload)
     VALUES ('image_warm', 'orphan-cover:320', $1::jsonb)`,
    [JSON.stringify({ sourceId, remoteId: 'orphan-cover', size: 320 })],
  );
  assert.equal(await imageWarm.enqueueCatalogImages(320), 0);
  assert.equal(await imageWarm.claim('inactive-image-worker'), null);
  assert.equal((await imageWarm.stats()).pending, 0);

  console.log('Cache smoke passed: mirror, details, disappearance confirmation, objects and durable lyrics.');
} finally {
  if (sourceId) await db.query('DELETE FROM music_sources WHERE id = $1', [sourceId]).catch(() => undefined);
  await db.close();
  await rm(cacheDirectory, { recursive: true, force: true });
}
