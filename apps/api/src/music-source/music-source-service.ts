import type {
  AdminMusicSource, Album, AlbumDetail, Artist, ArtistDetail, HabitAlbum, HabitArtist,
  HabitKind, HabitPeriod, HabitsResponse, HabitTrack, LibraryHomeResponse, SearchResponse, Track,
} from '@hirmos/contracts';
import { MusicSourceRepository, type StoredMusicSource } from './music-source-repository.js';
import { SourceCredentialCipher } from './source-credential-cipher.js';
import type {
  SourceAlbum, SourceArtist, SourceMedia, SourceProbeResult, SourceTrack,
} from './music-source-adapter.js';
import {
  DefaultMusicSourceAdapterFactory,
  type MusicSourceAdapterFactory,
} from './music-source-adapter-factory.js';
import { decodeTrackReference, encodeTrackReference } from './track-reference.js';
import type { ActivityRepository, HabitEvidence } from '../activity/activity-repository.js';
import type { CatalogRepository } from '../activity/catalog-repository.js';
import type { LyricsRepository } from '../lyrics/lyrics-repository.js';
import type { LyricsProvider } from '../lyrics/lyrics-provider.js';
import { createHash } from 'node:crypto';
import type { ArtistTagService } from '../metadata/artist-tag-service.js';
import { trackKey, type FavoriteRepository } from '../favorites/favorite-repository.js';
import type { ImageCacheService } from '../cache/image-cache-service.js';
import type { LyricsObjectCache } from '../cache/lyrics-object-cache.js';

export class MusicSourceUnavailableError extends Error {}

export class MusicSourceService {
  private readonly artistTagLookups = new Map<string, Promise<Array<{
    name: string; browsable: boolean; reference: string | null;
  }>>>();
  private readonly artistDetailRefreshes = new Map<string, Promise<void>>();

  public constructor(
    private readonly repository: MusicSourceRepository,
    private readonly cipher: SourceCredentialCipher,
    private readonly adapters: MusicSourceAdapterFactory = new DefaultMusicSourceAdapterFactory(),
    private readonly activity?: ActivityRepository,
    private readonly lyricsRepository?: LyricsRepository,
    private readonly lyricsProviders: readonly LyricsProvider[] = [],
    private readonly catalog?: CatalogRepository,
    private readonly artistTags?: ArtistTagService,
    private readonly favorites?: FavoriteRepository,
    private readonly imageCache?: ImageCacheService,
    private readonly lyricsObjectCache?: LyricsObjectCache,
  ) {}

  public async currentForAdmin(): Promise<AdminMusicSource | null> {
    const source = await this.repository.current();
    return source ? publicSource(source) : null;
  }

  public async syncCatalog(): Promise<{ artists: number; albums: number; tracks: number }> {
    if (!this.catalog) throw new MusicSourceUnavailableError('Catalog mirror is not configured');
    const source = await this.requireCurrent();
    const adapter = this.adapterFor(source);
    const run = await this.catalog.beginSync(source.id);
    let artistCount = 0;
    let albumCount = 0;
    let trackCount = 0;
    try {
      const artists = await adapter.listArtists(AbortSignal.timeout(20_000));
      await this.catalog.observeArtists(source.id, artists);
      artistCount = artists.length;

      for (let offset = 0; ; offset += 100) {
        const albums = await adapter.listAlbums(
          'alphabeticalByName', 100, offset, AbortSignal.timeout(20_000),
        );
        await this.catalog.observeAlbums(source.id, albums);
        albumCount += albums.length;
        if (albums.length < 100) break;
      }

      for (let offset = 0; ; offset += 100) {
        const tracks = await adapter.listTracks(100, offset, AbortSignal.timeout(20_000));
        await this.catalog.observeTracks(source.id, tracks);
        trackCount += tracks.length;
        if (tracks.length < 100) break;
      }

      await this.catalog.finishSync({
        id: run.id, sourceId: source.id, startedAt: run.startedAt,
        artists: artistCount, albums: albumCount, tracks: trackCount,
      });
      return { artists: artistCount, albums: albumCount, tracks: trackCount };
    } catch (error) {
      await this.catalog.failSync(run.id, error instanceof Error ? error.name : 'unknown')
        .catch(() => undefined);
      throw error;
    }
  }

  public async configure(input: {
    name: string;
    baseUrl: string;
    username: string;
    password: string;
  }): Promise<AdminMusicSource> {
    const baseUrl = normalizeBaseUrl(input.baseUrl);
    const probe = await this.probe({ ...input, baseUrl });
    const encrypted = this.cipher.encrypt({ username: input.username, password: input.password });
    return publicSource(await this.repository.replace({
      name: input.name.trim(),
      baseUrl,
      ciphertext: encrypted.ciphertext,
      keyVersion: encrypted.keyVersion,
      capabilities: probe.capabilities,
      serverVersion: probe.serverVersion,
    }));
  }

  public probe(input: {
    baseUrl: string;
    username: string;
    password: string;
  }): Promise<SourceProbeResult> {
    const adapter = this.adapters.create({
      adapterType: 'navidrome',
      baseUrl: new URL(normalizeBaseUrl(input.baseUrl)),
      username: input.username,
      password: input.password,
    });
    return adapter.probe(AbortSignal.timeout(10_000));
  }

  public async search(userId: string, query: string, cursor?: string): Promise<SearchResponse> {
    const source = await this.requireCurrent();
    const offset = parseCursor(cursor);
    const mirrorReady = await this.catalog?.isReady(source.id).catch(() => false) ?? false;
    const result = mirrorReady
      ? { ...(await this.catalog!.search(source.id, query, offset)), nextCursor: null }
      : await this.adapterFor(source).search(query, cursor, AbortSignal.timeout(10_000));
    return {
      artists: result.artists.map((artist) => publicArtist(source.id, artist)),
      albums: result.albums.map((album) => publicAlbum(source.id, album)),
      tracks: await this.personalizeTracks(
        userId, result.tracks.map((track) => publicTrack(source.id, track)),
      ),
      nextCursor: result.nextCursor,
    };
  }

  public async discover(userId: string, limit = 20): Promise<SearchResponse> {
    const source = await this.requireCurrent();
    const mirrorReady = await this.catalog?.isReady(source.id).catch(() => false) ?? false;
    const tracks = mirrorReady
      ? await this.catalog!.randomTracks(source.id, limit)
      : await this.adapterFor(source).discover(limit, AbortSignal.timeout(10_000));
    return {
      artists: [], albums: [],
      tracks: await this.personalizeTracks(
        userId, tracks.map((track) => publicTrack(source.id, track)),
      ),
      nextCursor: null,
    };
  }

  public async home(userId: string): Promise<LibraryHomeResponse> {
    const source = await this.requireCurrent();
    const adapter = this.adapterFor(source);
    const mirrorReady = await this.catalog?.isReady(source.id).catch(() => false) ?? false;
    const [recentRefs, habits, newest, rediscover] = await Promise.all([
      this.activity?.recentTrackReferences(userId, 10) ?? [],
      this.habits(userId, 'artists', '30d', 10),
      mirrorReady
        ? this.catalog!.listAlbums(source.id, 'newest', 10, 0)
        : adapter.listAlbums('newest', 10, 0, AbortSignal.timeout(10_000)),
      mirrorReady
        ? this.catalog!.listAlbums(source.id, 'random', 10, 0)
        : adapter.listAlbums('random', 10, 0, AbortSignal.timeout(10_000)),
    ]);
    const recentlyPlayed = await this.resolveTracks(userId, recentRefs);
    return {
      recentlyPlayed,
      topArtists: habits.artists,
      habitsSince: habits.dataSince,
      recentlyAdded: newest.map((album) => publicAlbum(source.id, album)),
      rediscover: rediscover.map((album) => publicAlbum(source.id, album)),
    };
  }

  public async habits(
    userId: string,
    kind: HabitKind,
    period: HabitPeriod,
    limit: number,
    cursor?: string,
  ): Promise<HabitsResponse> {
    const source = await this.requireCurrent();
    await this.ensureActivityCatalog(userId, source);
    const evidence = await this.activity?.habitEvidence(userId, habitStartDate(period)) ?? [];
    const dataSince = await this.activity?.habitsSince(userId) ?? null;
    const offset = parseCursor(cursor);
    const artists = kind === 'artists' ? aggregateArtists(evidence).slice(offset, offset + limit + 1) : [];
    const albums = kind === 'albums' ? aggregateAlbums(evidence).slice(offset, offset + limit + 1) : [];
    const tracks = kind === 'tracks' ? aggregateTracks(evidence).slice(offset, offset + limit + 1) : [];
    const selected = kind === 'artists' ? artists : kind === 'albums' ? albums : tracks;
    const hasMore = selected.length > limit;
    const visibleTracks = tracks.slice(0, limit);
    return {
      kind,
      period,
      dataSince,
      artists: artists.slice(0, limit),
      albums: albums.slice(0, limit),
      tracks: await this.personalizeTracks(userId, visibleTracks),
      nextCursor: hasMore ? String(offset + limit) : null,
    };
  }

  public async activityTracks(
    userId: string,
    kind: 'recent' | 'most-played',
    limit: number,
    cursor?: string,
  ) {
    const offset = parseCursor(cursor);
    const references = kind === 'recent'
      ? await this.activity?.recentTrackReferences(userId, limit + 1, offset) ?? []
      : await this.activity?.mostPlayedTrackReferences(userId, limit + 1, offset) ?? [];
    const page = references.slice(0, limit);
    return {
      tracks: await this.resolveTracks(userId, page),
      nextCursor: references.length > limit ? String(offset + page.length) : null,
    };
  }

  public async albums(
    sort: 'random' | 'newest' | 'frequent' | 'recent' | 'alphabeticalByName',
    limit: number,
    cursor?: string,
    year?: number,
  ) {
    const source = await this.requireCurrent();
    const offset = parseCursor(cursor);
    const adapter = this.adapterFor(source);
    const mirrorReady = await this.catalog?.isReady(source.id).catch(() => false) ?? false;
    const albums = mirrorReady
      ? await this.catalog!.listAlbums(source.id, sort, limit + 1, offset, year)
      : year
        ? await adapter.listAlbumsByYear(year, limit + 1, offset, AbortSignal.timeout(10_000))
        : await adapter.listAlbums(sort, limit + 1, offset, AbortSignal.timeout(10_000));
    const page = albums.slice(0, limit);
    return {
      albums: page.map((album) => publicAlbum(source.id, album)),
      nextCursor: albums.length > limit ? String(offset + page.length) : null,
    };
  }

  public async artists(limit: number, cursor?: string) {
    const source = await this.requireCurrent();
    const offset = parseCursor(cursor);
    const mirrorReady = await this.catalog?.isReady(source.id).catch(() => false) ?? false;
    const all = mirrorReady ? null : await this.adapterFor(source).listArtists(AbortSignal.timeout(10_000));
    const artists = mirrorReady
      ? await this.catalog!.listArtists(source.id, limit + 1, offset)
      : all!.slice(offset, offset + limit + 1);
    const page = artists.slice(0, limit);
    return {
      artists: page.map((artist) => publicArtist(source.id, artist)),
      nextCursor: mirrorReady
        ? artists.length > limit ? String(offset + page.length) : null
        : offset + page.length < all!.length ? String(offset + page.length) : null,
    };
  }

  public async tracks(userId: string, limit: number, cursor?: string) {
    const source = await this.requireCurrent();
    const offset = parseCursor(cursor);
    const mirrorReady = await this.catalog?.isReady(source.id).catch(() => false) ?? false;
    const tracks = mirrorReady
      ? await this.catalog!.listTracks(source.id, limit + 1, offset)
      : await this.adapterFor(source).listTracks(limit + 1, offset, AbortSignal.timeout(10_000));
    const page = tracks.slice(0, limit);
    return {
      tracks: await this.personalizeTracks(
        userId, page.map((track) => publicTrack(source.id, track)),
      ),
      nextCursor: tracks.length > limit ? String(offset + page.length) : null,
    };
  }

  public async libraryStats() {
    const source = await this.requireCurrent();
    const ready = await this.catalog?.isReady(source.id).catch(() => false) ?? false;
    const stats = await this.catalog?.stats(source.id) ?? {
      artists: 0, albums: 0, tracks: 0, genres: 0, syncedAt: null,
    };
    return { ...stats, ready, syncedAt: stats.syncedAt?.toISOString() ?? null };
  }

  public async genres() {
    const source = await this.requireCurrent();
    const mirrorReady = await this.catalog?.isReady(source.id).catch(() => false) ?? false;
    return {
      genres: mirrorReady
        ? await this.catalog!.listGenres(source.id)
        : await this.adapterFor(source).listGenres(AbortSignal.timeout(10_000)),
    };
  }

  public async genre(userId: string, name: string, limit: number) {
    const source = await this.requireCurrent();
    const adapter = this.adapterFor(source);
    const mirrorReady = await this.catalog?.isReady(source.id).catch(() => false) ?? false;
    const [albums, tracks] = await Promise.all([
      mirrorReady
        ? this.catalog!.listAlbumsByGenre(source.id, name, limit)
        : adapter.listAlbumsByGenre(name, limit, 0, AbortSignal.timeout(10_000)),
      mirrorReady
        ? this.catalog!.listTracksByGenre(source.id, name, Math.min(500, limit * 4))
        : adapter.listTracksByGenre(name, Math.min(500, limit * 4), 0, AbortSignal.timeout(10_000)),
    ]);
    return {
      genre: name,
      albums: albums.map((album) => publicAlbum(source.id, album)),
      tracks: await this.personalizeTracks(
        userId, tracks.map((track) => publicTrack(source.id, track)),
      ),
    };
  }

  public async album(userId: string, reference: string): Promise<AlbumDetail> {
    const { source, remoteId } = await this.resolveReference(reference);
    const mirrorReady = await this.catalog?.isReady(source.id).catch(() => false) ?? false;
    const album = mirrorReady
      ? await this.catalog!.albumDetail(source.id, remoteId)
        ?? await this.adapterFor(source).getAlbum(remoteId, AbortSignal.timeout(10_000))
      : await this.adapterFor(source).getAlbum(remoteId, AbortSignal.timeout(10_000));
    return {
      ...publicAlbum(source.id, album),
      tracks: await this.personalizeTracks(
        userId, album.tracks.map((track) => publicTrack(source.id, track)),
      ),
    };
  }

  public async artist(userId: string, reference: string): Promise<ArtistDetail> {
    const { source, remoteId } = await this.resolveReference(reference);
    const cached = await this.catalog?.artistDetail(source.id, remoteId).catch(() => null) ?? null;
    const artist = cached?.detail
      ?? await this.fetchAndCacheArtistDetail(source, remoteId);
    if (cached && cached.fetchedAt.valueOf() < Date.now() - 30 * 24 * 60 * 60 * 1_000) {
      this.refreshArtistDetail(source, remoteId);
    }
    const localGenres = localArtistGenres(artist)
      .map((name) => ({ name, browsable: true, reference: name }));
    if (this.artistTags) void this.startArtistTagLookup(source.id, artist).catch(() => undefined);
    return {
      ...publicArtist(source.id, artist),
      albums: artist.albums.map((album) => publicAlbum(source.id, album)),
      genres: localGenres,
      biography: artist.biography,
      externalUrl: artist.externalUrl,
      similarArtists: artist.similarArtists.map((item) => publicArtist(source.id, item)),
      topTracks: await this.personalizeTracks(
        userId, artist.topTracks.map((track) => publicTrack(source.id, track)),
      ),
    };
  }

  private async fetchAndCacheArtistDetail(
    source: StoredMusicSource,
    remoteId: string,
  ): Promise<import('./music-source-adapter.js').SourceArtistDetail> {
    const artist = await this.adapterFor(source).getArtist(remoteId, AbortSignal.timeout(10_000));
    await this.catalog?.observeArtistDetail(source.id, artist).catch(() => undefined);
    return artist;
  }

  private refreshArtistDetail(source: StoredMusicSource, remoteId: string): void {
    const key = `${source.id}:${remoteId}`;
    if (this.artistDetailRefreshes.has(key)) return;
    const operation = this.fetchAndCacheArtistDetail(source, remoteId)
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => this.artistDetailRefreshes.delete(key));
    this.artistDetailRefreshes.set(key, operation);
  }

  public async artistGenreTags(reference: string) {
    const { source, remoteId } = await this.resolveReference(reference);
    const key = `${source.id}:${remoteId}`;
    let lookup = this.artistTagLookups.get(key);
    let localGenres: Array<{ name: string; browsable: boolean; reference: string | null }> = [];
    if (!lookup) {
      const artist = (await this.catalog?.artistDetail(source.id, remoteId).catch(() => null))?.detail
        ?? await this.fetchAndCacheArtistDetail(source, remoteId);
      localGenres = localArtistGenres(artist)
        .map((name) => ({ name, browsable: true, reference: name }));
      lookup = this.artistTags ? this.startArtistTagLookup(source.id, artist) : undefined;
    }
    const genres = await lookup?.catch(() => []) ?? [];
    return { genres: genres.length ? genres : localGenres };
  }

  public async stream(reference: string, range?: string, signal?: AbortSignal): Promise<SourceMedia> {
    const { source, remoteId } = await this.resolveReference(reference);
    return this.adapterFor(source).getStream(remoteId, range, signal);
  }

  public async cover(reference: string, size = 320, signal?: AbortSignal): Promise<SourceMedia> {
    const { source, remoteId } = await this.resolveReference(reference);
    const adapter = this.adapterFor(source);
    if (!this.imageCache) return adapter.getCoverArt(remoteId, size, signal);
    return this.imageCache.get({
      sourceId: source.id,
      remoteId,
      size,
      load: (fillSignal) => adapter.getCoverArt(remoteId, size, fillSignal),
    });
  }

  public async warmCover(sourceId: string, remoteId: string, size = 320): Promise<void> {
    if (!this.imageCache) throw new MusicSourceUnavailableError('Image cache is not configured');
    const source = await this.requireCurrent();
    if (source.id !== sourceId) {
      throw new MusicSourceUnavailableError('Music source is no longer active');
    }
    const adapter = this.adapterFor(source);
    await this.imageCache.warm({
      sourceId, remoteId, size,
      load: (fillSignal) => adapter.getCoverArt(remoteId, size, fillSignal),
    });
  }

  public async warmArtistMetadata(sourceId: string, remoteId: string): Promise<void> {
    const source = await this.requireCurrent();
    if (source.id !== sourceId) {
      throw new MusicSourceUnavailableError('Music source is no longer active');
    }
    const artist = await this.fetchAndCacheArtistDetail(source, remoteId);
    await this.artistTags?.resolve(source.id, artist);
  }

  public async lyrics(reference: string, userId: string, signal?: AbortSignal) {
    const { source, remoteId } = await this.resolveReference(reference);
    const adapter = this.adapterFor(source);
    const adjustmentMs = await this.lyricsRepository?.getAdjustment(
      userId, source.id, remoteId,
    ) ?? 0;
    const mirroredTrack = this.lyricsRepository && this.catalog
      ? (await this.catalog.tracksByIds(source.id, [remoteId]).catch(() => []))[0]
      : undefined;
    const track = this.lyricsRepository ? mirroredTrack ?? await adapter.getTrack(remoteId, signal) : null;
    const fingerprint = track ? lyricsFingerprint(track) : null;
    let providerUnavailable = false;
    let staleLyrics: Awaited<ReturnType<LyricsRepository['getStaleFound']>>;
    if (this.lyricsProviders.length && this.lyricsRepository) {
      if (!track || !fingerprint) throw new MusicSourceUnavailableError('Track metadata unavailable');
      for (const provider of this.lyricsProviders) {
        const cached = await this.lyricsRepository.get({
          sourceId: source.id, remoteTrackId: remoteId,
          provider: provider.name, fingerprint,
        });
        if (cached?.length) return { lyrics: cached, adjustmentMs, availability: 'available' as const };
        if (cached !== undefined) continue;
        try {
          const providerSignal = signal
            ? AbortSignal.any([signal, AbortSignal.timeout(provider.timeoutMs ?? 8_000)])
            : AbortSignal.timeout(provider.timeoutMs ?? 8_000);
          const found = await provider.find(track, providerSignal);
          const rawCache = found ? await this.cacheLyricsObject({
            sourceId: source.id,
            remoteTrackId: remoteId,
            provider: provider.name,
            fingerprint,
            raw: found.raw,
            document: found.document,
          }) : null;
          await this.lyricsRepository.put({
            sourceId: source.id, remoteTrackId: remoteId,
            provider: provider.name, fingerprint,
            providerItemId: found?.providerItemId,
            instrumental: found?.instrumental,
            rawObjectKey: rawCache?.key,
            parserVersion: rawCache?.parserVersion,
            document: found?.document ?? null,
          });
          if (found) {
            return { lyrics: [found.document], adjustmentMs, availability: 'available' as const };
          }
        } catch {
          providerUnavailable = true;
          staleLyrics ??= await this.lyricsRepository.getStaleFound({
            sourceId: source.id, remoteTrackId: remoteId,
            provider: provider.name, fingerprint,
          }).catch(() => undefined);
        }
      }
    }
    if (staleLyrics?.length) {
      return { lyrics: staleLyrics, adjustmentMs, availability: 'available' as const };
    }
    const cachedSourceLyrics = await this.lyricsRepository?.get({
      sourceId: source.id,
      remoteTrackId: remoteId,
      provider: 'opensubsonic',
      fingerprint: fingerprint ?? remoteId,
    });
    if (cachedSourceLyrics?.length) {
      return { lyrics: cachedSourceLyrics, adjustmentMs, availability: 'available' as const };
    }
    const sourceLyrics = cachedSourceLyrics === null ? [] : await adapter.getLyrics(remoteId, signal);
    if (sourceLyrics.length && this.lyricsRepository) {
      const rawCache = await this.cacheLyricsObject({
        sourceId: source.id,
        remoteTrackId: remoteId,
        provider: 'opensubsonic',
        fingerprint: fingerprint ?? remoteId,
        document: sourceLyrics[0]!,
      });
      await this.lyricsRepository.put({
        sourceId: source.id,
        remoteTrackId: remoteId,
        provider: 'opensubsonic',
        fingerprint: fingerprint ?? remoteId,
        rawObjectKey: rawCache?.key,
        parserVersion: rawCache?.parserVersion,
        document: sourceLyrics[0]!,
      });
    } else if (!providerUnavailable && cachedSourceLyrics === undefined && this.lyricsRepository) {
      await this.lyricsRepository.put({
        sourceId: source.id,
        remoteTrackId: remoteId,
        provider: 'opensubsonic',
        fingerprint: fingerprint ?? remoteId,
        document: null,
      });
    }
    return {
      lyrics: sourceLyrics,
      adjustmentMs,
      availability: sourceLyrics.length
        ? 'available' as const
        : providerUnavailable ? 'temporarily_unavailable' as const : 'not_found' as const,
    };
  }

  private async cacheLyricsObject(input: {
    sourceId: string;
    remoteTrackId: string;
    provider: string;
    fingerprint: string;
    raw?: import('../cache/lyrics-object-cache.js').RawLyricsDocument;
    document: import('./music-source-adapter.js').SourceLyrics;
  }): Promise<{ key: string; parserVersion: string } | null> {
    if (!this.lyricsObjectCache) return null;
    return this.lyricsObjectCache.put({
      sourceId: input.sourceId,
      remoteTrackId: input.remoteTrackId,
      provider: input.provider,
      fingerprint: input.fingerprint,
      raw: input.raw,
      normalized: input.document,
    }).catch(() => null);
  }

  public async setLyricsAdjustment(
    reference: string,
    userId: string,
    adjustmentMs: number,
  ): Promise<{ adjustmentMs: number }> {
    if (!this.lyricsRepository) throw new MusicSourceUnavailableError('Lyrics are not configured');
    const { source, remoteId } = await this.resolveReference(reference);
    await this.lyricsRepository.putAdjustment({
      userId, sourceId: source.id, remoteTrackId: remoteId, adjustmentMs,
    });
    return { adjustmentMs };
  }

  public async track(userId: string, reference: string, signal?: AbortSignal) {
    const [track] = await this.resolveTracks(userId, [reference]);
    if (!track) throw new MusicSourceUnavailableError('Track metadata unavailable');
    return track;
  }

  public async tracksByReferences(userId: string, references: string[]) {
    return { tracks: await this.resolveTracks(userId, references) };
  }

  public async favoriteTracks(userId: string, limit: number, cursor?: string) {
    if (!this.favorites) throw new MusicSourceUnavailableError('Favorites are not configured');
    const offset = parseCursor(cursor);
    const references = await this.favorites.trackReferences(userId, limit + 1, offset);
    const page = references.slice(0, limit);
    return {
      tracks: await this.resolveTracks(userId, page),
      nextCursor: references.length > limit ? String(offset + page.length) : null,
    };
  }

  public async setTrackFavorite(userId: string, reference: string, favorite: boolean) {
    if (!this.favorites) throw new MusicSourceUnavailableError('Favorites are not configured');
    const { source, remoteId } = await this.resolveReference(reference);
    if (favorite) {
      const track = await this.adapterFor(source).getTrack(remoteId, AbortSignal.timeout(8_000));
      try { await this.catalog?.observeTracks(source.id, [track]); }
      catch { /* Catalog enrichment must never interrupt a personal action. */ }
    }
    await this.favorites.setTrack(userId, source.id, remoteId, favorite);
    return { reference, favorite };
  }

  private async requireCurrent(): Promise<StoredMusicSource> {
    const source = await this.repository.current();
    if (!source) throw new MusicSourceUnavailableError('No music source configured');
    return source;
  }

  private adapterFor(source: StoredMusicSource) {
    const credentials = this.cipher.decrypt(
      source.credentialCiphertext,
      source.encryptionKeyVersion,
    );
    return this.adapters.create({
      adapterType: source.adapterType,
      baseUrl: new URL(source.baseUrl),
      ...credentials,
    });
  }

  private async resolveReference(reference: string): Promise<{
    source: StoredMusicSource;
    remoteId: string;
  }> {
    const source = await this.requireCurrent();
    const decoded = decodeTrackReference(reference);
    if (!decoded || decoded.sourceId !== source.id) {
      throw new MusicSourceUnavailableError('Unknown track reference');
    }
    return { source, remoteId: decoded.remoteId };
  }

  private async resolveTracks(userId: string, references: string[]): Promise<Track[]> {
    const source = await this.requireCurrent();
    const decoded = references.flatMap((reference) => {
      const identity = decodeTrackReference(reference);
      return identity?.sourceId === source.id ? [identity] : [];
    });
    const cached = await this.catalog?.tracksByIds(
      source.id, decoded.map((identity) => identity.remoteId),
    ).catch(() => []) ?? [];
    const byId = new Map(cached.map((track) => [track.id, publicTrack(source.id, track)]));
    const missing = decoded.filter((identity) => !byId.has(identity.remoteId));
    for (let index = 0; index < missing.length; index += 6) {
      await Promise.all(missing.slice(index, index + 6).map(async (identity) => {
        try {
          const track = await this.fetchTrack(
            encodeTrackReference(source.id, identity.remoteId), AbortSignal.timeout(8_000),
          );
          byId.set(identity.remoteId, track);
        } catch { /* A removed source item is omitted from this response. */ }
      }));
    }
    const ordered = decoded.flatMap((identity) => {
      const track = byId.get(identity.remoteId);
      return track ? [track] : [];
    });
    return this.personalizeTracks(userId, ordered);
  }

  private async fetchTrack(reference: string, signal?: AbortSignal): Promise<Track> {
    const { source, remoteId } = await this.resolveReference(reference);
    const track = await this.adapterFor(source).getTrack(remoteId, signal);
    try { await this.catalog?.observeTracks(source.id, [track]); }
    catch { /* Catalog enrichment must never interrupt playback or library browsing. */ }
    return publicTrack(source.id, track);
  }

  private async personalizeTracks<T extends Track>(userId: string, tracks: T[]): Promise<T[]> {
    if (!tracks.length) return tracks;
    const identities = tracks.flatMap((track) => {
      const decoded = decodeTrackReference(track.id);
      return decoded ? [{ sourceId: decoded.sourceId, remoteTrackId: decoded.remoteId }] : [];
    });
    if (!this.favorites || !identities.length) {
      return tracks.map((track) => ({ ...track, favorite: false }));
    }
    try {
      const favoriteKeys = await this.favorites.matchingTrackKeys(userId, identities);
      return tracks.map((track) => {
        const decoded = decodeTrackReference(track.id);
        return {
          ...track,
          favorite: Boolean(decoded && favoriteKeys.has(trackKey(decoded.sourceId, decoded.remoteId))),
        };
      });
    } catch {
      // Personal metadata must not make the shared library unavailable.
      return tracks.map((track) => ({ ...track, favorite: false }));
    }
  }

  private startArtistTagLookup(
    sourceId: string,
    artist: import('./music-source-adapter.js').SourceArtistDetail,
  ): Promise<Array<{ name: string; browsable: boolean; reference: string | null }>> {
    const key = `${sourceId}:${artist.id}`;
    const existing = this.artistTagLookups.get(key);
    if (existing) return existing;
    const lookup = this.artistTags!.resolve(sourceId, artist);
    this.artistTagLookups.set(key, lookup);
    const timer = setTimeout(() => this.artistTagLookups.delete(key), 60_000);
    timer.unref();
    return lookup;
  }

  private async ensureActivityCatalog(userId: string, source: StoredMusicSource): Promise<void> {
    if (!this.activity || !this.catalog) return;
    const references = await this.activity.trackedReferences(userId);
    const ids = references.flatMap((reference) => {
      const decoded = decodeTrackReference(reference);
      return decoded?.sourceId === source.id ? [decoded.remoteId] : [];
    });
    const missing = await this.catalog.missingTrackIds(source.id, ids);
    const adapter = this.adapterFor(source);
    const observed: SourceTrack[] = [];
    for (let index = 0; index < missing.length; index += 6) {
      const batch = await Promise.all(missing.slice(index, index + 6).map(async (id) => {
        try { return await adapter.getTrack(id, AbortSignal.timeout(8_000)); }
        catch { return null; }
      }));
      observed.push(...batch.filter((track): track is SourceTrack => track !== null));
    }
    await this.catalog.observeTracks(source.id, observed);
    const missingArtistIds = await this.catalog.missingArtistIds(source.id, ids);
    if (missingArtistIds.length) {
      const artistIds = new Set(missingArtistIds);
      try {
        const artists = await adapter.listArtists(AbortSignal.timeout(10_000));
        await this.catalog.observeArtists(
          source.id,
          artists.filter((artist) => artistIds.has(artist.id)),
        );
      } catch {
        // Album artwork from catalog_tracks remains a usable fallback.
      }
    }
  }
}

interface HabitAccumulator {
  evidence: HabitEvidence;
  listenedMs: number;
  playStarts: number;
  qualifiedPlays: number;
  importedPlays: number;
  completions: number;
  skips: number;
  trackIds: Set<string>;
  lastPlayedAt: string | null;
  estimated: boolean;
}

function aggregateArtists(evidence: HabitEvidence[]): HabitArtist[] {
  const groups = new Map<string, HabitAccumulator>();
  for (const item of evidence) {
    if (!item.remoteArtistId) continue;
    const key = item.canonicalArtistId ?? `${item.sourceId}:${item.remoteArtistId}`;
    addEvidence(groups, key, item);
  }
  return [...groups.values()].sort(compareHabits).map((group) => ({
    id: encodeTrackReference(group.evidence.sourceId, group.evidence.remoteArtistId!),
    name: group.evidence.canonicalArtistName ?? group.evidence.artist,
    coverUrl: publicCoverUrl(
      group.evidence.sourceId,
      group.evidence.artistCoverArtId ?? group.evidence.coverArtId,
    ),
    albumCount: 0,
    favorite: false,
    ...habitMetrics(group),
  }));
}

function aggregateAlbums(evidence: HabitEvidence[]): HabitAlbum[] {
  const groups = new Map<string, HabitAccumulator>();
  for (const item of evidence) {
    const key = item.remoteAlbumId
      ? `${item.sourceId}:${item.remoteAlbumId}`
      : `${item.sourceId}:name:${item.artist}\u0000${item.album}`;
    addEvidence(groups, key, item);
  }
  return [...groups.values()].sort(compareHabits).map((group) => ({
    id: group.evidence.remoteAlbumId
      ? encodeTrackReference(group.evidence.sourceId, group.evidence.remoteAlbumId)
      : '',
    name: group.evidence.album,
    artist: group.evidence.canonicalArtistName ?? group.evidence.artist,
    artistId: group.evidence.remoteArtistId
      ? encodeTrackReference(group.evidence.sourceId, group.evidence.remoteArtistId) : null,
    coverUrl: publicCoverUrl(group.evidence.sourceId, group.evidence.coverArtId),
    songCount: group.trackIds.size,
    durationMs: 0,
    year: group.evidence.year,
    genre: null,
    genres: [],
    favorite: false,
    playCount: null,
    ...habitMetrics(group),
  }));
}

function aggregateTracks(evidence: HabitEvidence[]): HabitTrack[] {
  return evidence.map((item) => ({
    id: encodeTrackReference(item.sourceId, item.remoteTrackId),
    title: item.title,
    artist: item.canonicalArtistName ?? item.artist,
    artistId: item.remoteArtistId ? encodeTrackReference(item.sourceId, item.remoteArtistId) : null,
    album: item.album,
    albumId: item.remoteAlbumId ? encodeTrackReference(item.sourceId, item.remoteAlbumId) : null,
    durationMs: item.durationMs,
    coverUrl: publicCoverUrl(item.sourceId, item.coverArtId),
    year: item.year,
    genres: [],
    favorite: false,
    listenedMs: item.listenedMs,
    playStarts: item.playStarts,
    qualifiedPlays: item.qualifiedPlays,
    importedPlays: item.importedPlays,
    completions: item.completions,
    skips: item.skips,
    trackCount: 1,
    lastPlayedAt: item.lastPlayedAt,
    estimated: item.estimated,
  })).sort(compareHabits);
}

function addEvidence(groups: Map<string, HabitAccumulator>, key: string, item: HabitEvidence): void {
  const current = groups.get(key);
  if (!current) {
    groups.set(key, {
      evidence: item,
      listenedMs: item.listenedMs,
      playStarts: item.playStarts,
      qualifiedPlays: item.qualifiedPlays,
      importedPlays: item.importedPlays,
      completions: item.completions,
      skips: item.skips,
      trackIds: new Set([`${item.sourceId}:${item.remoteTrackId}`]),
      lastPlayedAt: item.lastPlayedAt,
      estimated: item.estimated,
    });
    return;
  }
  current.listenedMs += item.listenedMs;
  current.playStarts += item.playStarts;
  current.qualifiedPlays += item.qualifiedPlays;
  current.importedPlays += item.importedPlays;
  current.completions += item.completions;
  current.skips += item.skips;
  current.trackIds.add(`${item.sourceId}:${item.remoteTrackId}`);
  current.estimated ||= item.estimated;
  if ((item.lastPlayedAt ?? '') > (current.lastPlayedAt ?? '')) current.lastPlayedAt = item.lastPlayedAt;
  if (compareEvidence(item, current.evidence) < 0) current.evidence = item;
}

function habitMetrics(group: HabitAccumulator) {
  return {
    listenedMs: group.listenedMs,
    playStarts: group.playStarts,
    qualifiedPlays: group.qualifiedPlays,
    importedPlays: group.importedPlays,
    completions: group.completions,
    skips: group.skips,
    trackCount: group.trackIds.size,
    lastPlayedAt: group.lastPlayedAt,
    estimated: group.estimated,
  };
}

function compareHabits(
  left: Pick<HabitAccumulator, 'importedPlays' | 'listenedMs' | 'qualifiedPlays' | 'lastPlayedAt'>,
  right: Pick<HabitAccumulator, 'importedPlays' | 'listenedMs' | 'qualifiedPlays' | 'lastPlayedAt'>,
): number {
  return habitWeight(right) - habitWeight(left)
    || right.qualifiedPlays - left.qualifiedPlays
    || (right.lastPlayedAt ?? '').localeCompare(left.lastPlayedAt ?? '');
}

function compareEvidence(left: HabitEvidence, right: HabitEvidence): number {
  return habitWeight(right) - habitWeight(left)
    || right.qualifiedPlays - left.qualifiedPlays
    || (right.lastPlayedAt ?? '').localeCompare(left.lastPlayedAt ?? '');
}

// Imported scrobbles have no trustworthy duration. Give each one a neutral
// three-minute ranking weight without presenting that estimate as listened time.
function habitWeight(value: Pick<HabitAccumulator, 'importedPlays' | 'listenedMs'>): number {
  return value.listenedMs + value.importedPlays * 180_000;
}

function publicCoverUrl(sourceId: string, coverArtId: string | null): string | null {
  return coverArtId ? `/api/music/covers/${encodeTrackReference(sourceId, coverArtId)}` : null;
}

function habitStartDate(period: HabitPeriod): string | null {
  if (period === 'all') return null;
  const value = new Date();
  if (period === '7d') value.setUTCDate(value.getUTCDate() - 6);
  if (period === '30d') value.setUTCDate(value.getUTCDate() - 29);
  if (period === '12m') value.setUTCMonth(value.getUTCMonth() - 12);
  return value.toISOString().slice(0, 10);
}

function publicSource(source: StoredMusicSource): AdminMusicSource {
  const { credentialCiphertext: _ciphertext, encryptionKeyVersion: _version, ...summary } = source;
  return summary;
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  url.pathname = url.pathname.replace(/\/$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

function publicTrack(sourceId: string, track: SourceTrack): Track {
  const { coverArtId, artistId, albumId, musicBrainzId: _musicBrainzId, ...summary } = track;
  return {
    ...summary,
    id: encodeTrackReference(sourceId, track.id),
    coverUrl: coverArtId
      ? `/api/music/covers/${encodeTrackReference(sourceId, coverArtId)}`
      : null,
    artistId: artistId ? encodeTrackReference(sourceId, artistId) : null,
    albumId: albumId ? encodeTrackReference(sourceId, albumId) : null,
  };
}

function publicArtist(sourceId: string, artist: SourceArtist): Artist {
  return {
    id: encodeTrackReference(sourceId, artist.id),
    name: artist.name,
    coverUrl: artist.coverArtId
      ? `/api/music/covers/${encodeTrackReference(sourceId, artist.coverArtId)}` : null,
    albumCount: artist.albumCount,
    favorite: artist.favorite,
  };
}

function publicAlbum(sourceId: string, album: SourceAlbum): Album {
  return {
    id: encodeTrackReference(sourceId, album.id),
    name: album.name,
    artist: album.artist,
    artistId: album.artistId ? encodeTrackReference(sourceId, album.artistId) : null,
    coverUrl: album.coverArtId
      ? `/api/music/covers/${encodeTrackReference(sourceId, album.coverArtId)}` : null,
    songCount: album.songCount,
    durationMs: album.durationMs,
    year: album.year,
    genre: album.genre,
    genres: album.genres,
    favorite: album.favorite,
    playCount: album.playCount,
    lastPlayedAt: normalizeDate(album.lastPlayedAt),
  };
}

function localArtistGenres(artist: SourceArtist): string[];
function localArtistGenres(artist: import('./music-source-adapter.js').SourceArtistDetail): string[];
function localArtistGenres(
  artist: SourceArtist | import('./music-source-adapter.js').SourceArtistDetail,
): string[] {
  if (!('albums' in artist)) return [];
  const counts = new Map<string, { name: string; count: number }>();
  for (const album of artist.albums) {
    for (const genre of album.genres) {
      const key = genre.toLocaleLowerCase();
      counts.set(key, { name: genre, count: (counts.get(key)?.count ?? 0) + 1 });
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count).slice(0, 5).map((item) => item.name);
}

function parseCursor(cursor: string | undefined): number {
  const value = Number.parseInt(cursor ?? '0', 10);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function normalizeDate(value: string | null): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString();
}

function lyricsFingerprint(track: SourceTrack): string {
  return createHash('sha256').update([
    track.title.trim().toLocaleLowerCase(),
    track.artist.trim().toLocaleLowerCase(),
    track.album.trim().toLocaleLowerCase(),
    String(Math.round(track.durationMs / 1_000)),
  ].join('\u0000')).digest('hex');
}
