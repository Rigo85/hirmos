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

const config = loadConfig();
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
const artistTagService = database
  ? new ArtistTagService(
      new TagRepository(database),
      [new MusicBrainzTagProvider(), ...(config.LASTFM_API_KEY
        ? [new LastFmTagProvider(config.LASTFM_API_KEY)] : [])],
    )
  : undefined;
const musicSourceService = database && config.DATA_ENCRYPTION_KEY
  ? new MusicSourceService(
      new MusicSourceRepository(database),
      new SourceCredentialCipher(config.DATA_ENCRYPTION_KEY),
      undefined,
      activityRepository,
      new LyricsRepository(database),
      [new AmllLyricsProvider(), new LrclibLyricsProvider()],
      new CatalogRepository(database),
      artistTagService,
      new FavoriteRepository(database),
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
const io = createSocketServer(app.server, config, authService, playbackService, revocations);
const mailProvider = await createSmtpMailProvider(config);
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
  await app.close();
  await database?.close();
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await app.listen({ host: config.HOST, port: config.PORT });
} catch (error) {
  app.log.fatal(error, 'Failed to start Hirmos');
  await shutdown('startup-error');
  process.exitCode = 1;
}
