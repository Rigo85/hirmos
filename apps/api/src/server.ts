import { PostgresAuthRepository } from './auth/auth-repository.js';
import { AccountService } from './auth/account-service.js';
import { PostgresAccountRepository } from './auth/account-repository.js';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createDatabase } from './db/database.js';
import { createSocketServer } from './socket/socket-server.js';
import { AesGcmOutboxCipher } from './mail/outbox-cipher.js';
import { createSmtpMailProvider } from './mail/mail-provider.js';
import { OutboxRepository } from './mail/outbox-repository.js';
import { OutboxWorker } from './mail/outbox-worker.js';
import { MusicSourceRepository } from './music-source/music-source-repository.js';
import { MusicSourceService } from './music-source/music-source-service.js';
import { SourceCredentialCipher } from './music-source/source-credential-cipher.js';
import { AuthService } from './auth/auth-service.js';
import { PlaybackRepository } from './playback/playback-repository.js';
import { PlaybackService } from './playback/playback-service.js';
import { SessionRevocationNotifier } from './auth/session-revocation.js';
import { ActivityRepository } from './activity/activity-repository.js';
import { CatalogRepository } from './activity/catalog-repository.js';
import { LyricsRepository } from './lyrics/lyrics-repository.js';
import { LrclibLyricsProvider } from './lyrics/lrclib-lyrics-provider.js';
import { AmllLyricsProvider } from './lyrics/amll-lyrics-provider.js';
import { ArtistTagService } from './metadata/artist-tag-service.js';
import { LastFmTagProvider } from './metadata/lastfm-tag-provider.js';
import { MusicBrainzTagProvider } from './metadata/musicbrainz-tag-provider.js';
import { TagRepository } from './metadata/tag-repository.js';
import { FavoriteRepository } from './favorites/favorite-repository.js';
import { ThirdPartyTelemetry } from './integrations/third-party-request.js';
import { DefaultMusicSourceAdapterFactory } from './music-source/music-source-adapter-factory.js';
import { CacheRepository } from './cache/cache-repository.js';
import { ObjectStore } from './cache/object-store.js';
import { ImageCacheService } from './cache/image-cache-service.js';
import { CatalogSyncWorker } from './cache/catalog-sync-worker.js';
import { LyricsObjectCache } from './cache/lyrics-object-cache.js';
import { CacheMaintenanceWorker } from './cache/cache-maintenance-worker.js';
import { LyricsCacheBackfillWorker } from './cache/lyrics-cache-backfill-worker.js';
import { ImageWarmRepository } from './cache/image-warm-repository.js';
import { ImageWarmWorker } from './cache/image-warm-worker.js';
import { MetadataWarmRepository } from './cache/metadata-warm-repository.js';
import { MetadataWarmWorker } from './cache/metadata-warm-worker.js';

const config = loadConfig();
const thirdPartyTelemetry = new ThirdPartyTelemetry();
const database = config.DATABASE_URL ? createDatabase(config.DATABASE_URL) : null;
const revocations = new SessionRevocationNotifier();
const authService = database
  ? new AuthService(new PostgresAuthRepository(database), undefined, revocations)
  : undefined;
const outboxCipher = config.DATA_ENCRYPTION_KEY
  ? new AesGcmOutboxCipher(config.DATA_ENCRYPTION_KEY)
  : null;
const accountService = database && outboxCipher
  ? new AccountService(
      new PostgresAccountRepository(database),
      outboxCipher,
      config.PUBLIC_ORIGIN,
      undefined,
      revocations,
    )
  : undefined;
const activityRepository = database ? new ActivityRepository(database) : undefined;
const lyricsRepository = database ? new LyricsRepository(database) : undefined;
const cacheRepository = database && config.HIRMOS_CACHE_DIR
  ? new CacheRepository(database) : undefined;
const objectStore = database && config.HIRMOS_CACHE_DIR
  ? new ObjectStore(config.HIRMOS_CACHE_DIR) : undefined;
const imageCache = cacheRepository && objectStore
  ? new ImageCacheService(cacheRepository, objectStore, config.IMAGE_CACHE_CONCURRENCY)
  : undefined;
const lyricsObjectCache = cacheRepository && objectStore
  ? new LyricsObjectCache(cacheRepository, objectStore) : undefined;
await objectStore?.initialize();
const artistTagService = database
  ? new ArtistTagService(
      new TagRepository(database),
      [new MusicBrainzTagProvider(fetch, thirdPartyTelemetry), ...(config.LASTFM_API_KEY
        ? [new LastFmTagProvider(config.LASTFM_API_KEY, fetch, thirdPartyTelemetry)] : [])],
    )
  : undefined;
const musicSourceService = database && config.DATA_ENCRYPTION_KEY
  ? new MusicSourceService(
      new MusicSourceRepository(database),
      new SourceCredentialCipher(config.DATA_ENCRYPTION_KEY),
      new DefaultMusicSourceAdapterFactory(thirdPartyTelemetry),
      activityRepository,
      lyricsRepository,
      [
        new AmllLyricsProvider(fetch, thirdPartyTelemetry),
        new LrclibLyricsProvider(fetch, thirdPartyTelemetry),
      ],
      new CatalogRepository(database),
      artistTagService,
      new FavoriteRepository(database),
      imageCache,
      lyricsObjectCache,
    )
  : undefined;
const playbackService = database
  ? new PlaybackService(new PlaybackRepository(database), activityRepository)
  : undefined;
const app = await buildApp({
  config,
  authService,
  accountService,
  musicSourceService,
  database: database ?? undefined,
});
thirdPartyTelemetry.attachLogger(app.log);
const cacheMaintenanceWorker = cacheRepository && objectStore
  ? new CacheMaintenanceWorker(
      cacheRepository,
      objectStore,
      app.log,
      config.HIRMOS_CACHE_MAX_GB * 1024 * 1024 * 1024,
    )
  : null;
const lyricsCacheBackfillWorker = lyricsRepository && lyricsObjectCache
  ? new LyricsCacheBackfillWorker(lyricsRepository, lyricsObjectCache, app.log)
  : null;
const imageWarmWorker = database && imageCache && musicSourceService
  ? new ImageWarmWorker(new ImageWarmRepository(database), musicSourceService, app.log)
  : null;
const metadataWarmWorker = database && musicSourceService
  ? new MetadataWarmWorker(new MetadataWarmRepository(database), musicSourceService, app.log)
  : null;
const catalogSyncWorker = musicSourceService
  ? new CatalogSyncWorker(
      musicSourceService,
      app.log,
      config.CATALOG_SYNC_INTERVAL_HOURS * 60 * 60 * 1_000,
      async () => {
        await imageWarmWorker?.enqueueNow();
        await metadataWarmWorker?.enqueueNow();
      },
    )
  : null;
const io = createSocketServer(app.server, config, authService, playbackService, revocations);
const mailProvider = await createSmtpMailProvider(config, thirdPartyTelemetry);
const outboxWorker = database && outboxCipher && mailProvider
  ? new OutboxWorker(new OutboxRepository(database), outboxCipher, mailProvider, app.log)
  : null;
outboxWorker?.start();

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'Graceful shutdown started');
  io.close();
  await outboxWorker?.stop();
  catalogSyncWorker?.stop();
  cacheMaintenanceWorker?.stop();
  lyricsCacheBackfillWorker?.stop();
  await imageWarmWorker?.stop();
  await metadataWarmWorker?.stop();
  await app.close();
  await database?.close();
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await app.listen({ host: config.HOST, port: config.PORT });
  catalogSyncWorker?.start();
  cacheMaintenanceWorker?.start();
  lyricsCacheBackfillWorker?.start();
  imageWarmWorker?.start();
  metadataWarmWorker?.start();
} catch (error) {
  app.log.fatal(error, 'Failed to start Hirmos');
  await shutdown('startup-error');
  process.exitCode = 1;
}
