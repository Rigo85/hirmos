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

export class MusicSourceUnavailableError extends Error {}

export class MusicSourceService {
  public constructor(
    private readonly repository: MusicSourceRepository,
    private readonly cipher: SourceCredentialCipher,
    private readonly adapters: MusicSourceAdapterFactory = new DefaultMusicSourceAdapterFactory(),
    private readonly activity?: ActivityRepository,
    private readonly lyricsRepository?: LyricsRepository,
    private readonly lyricsProviders: readonly LyricsProvider[] = [],
    private readonly catalog?: CatalogRepository,
  ) {}

  public async currentForAdmin(): Promise<AdminMusicSource | null> {
    const source = await this.repository.current();
    return source ? publicSource(source) : null;
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

  public async search(query: string, cursor?: string): Promise<SearchResponse> {
    const source = await this.requireCurrent();
    const result = await this.adapterFor(source).search(query, cursor, AbortSignal.timeout(10_000));
    return {
      artists: result.artists.map((artist) => publicArtist(source.id, artist)),
      albums: result.albums.map((album) => publicAlbum(source.id, album)),
      tracks: result.tracks.map((track) => publicTrack(source.id, track)),
      nextCursor: result.nextCursor,
    };
  }

  public async discover(limit = 20): Promise<SearchResponse> {
    const source = await this.requireCurrent();
    const tracks = await this.adapterFor(source).discover(limit, AbortSignal.timeout(10_000));
    return { artists: [], albums: [], tracks: tracks.map((track) => publicTrack(source.id, track)), nextCursor: null };
  }

  public async home(userId: string): Promise<LibraryHomeResponse> {
    const source = await this.requireCurrent();
    const adapter = this.adapterFor(source);
    const [recentRefs, habits, newest, rediscover] = await Promise.all([
      this.activity?.recentTrackReferences(userId, 10) ?? [],
      this.habits(userId, 'artists', '30d', 10),
      adapter.listAlbums('newest', 10, 0, AbortSignal.timeout(10_000)),
      adapter.listAlbums('random', 10, 0, AbortSignal.timeout(10_000)),
    ]);
    const recentlyPlayed = await this.resolveTracks(recentRefs);
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
    return {
      kind,
      period,
      dataSince,
      artists: artists.slice(0, limit),
      albums: albums.slice(0, limit),
      tracks: tracks.slice(0, limit),
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
      tracks: await this.resolveTracks(page),
      nextCursor: references.length > limit ? String(offset + page.length) : null,
    };
  }

  public async albums(
    sort: 'random' | 'newest' | 'frequent' | 'recent' | 'alphabeticalByName',
    limit: number,
    cursor?: string,
  ) {
    const source = await this.requireCurrent();
    const offset = parseCursor(cursor);
    const albums = await this.adapterFor(source).listAlbums(
      sort, limit, offset, AbortSignal.timeout(10_000),
    );
    return {
      albums: albums.map((album) => publicAlbum(source.id, album)),
      nextCursor: albums.length === limit ? String(offset + albums.length) : null,
    };
  }

  public async artists(limit: number, cursor?: string) {
    const source = await this.requireCurrent();
    const offset = parseCursor(cursor);
    const all = await this.adapterFor(source).listArtists(AbortSignal.timeout(10_000));
    const artists = all.slice(offset, offset + limit);
    return {
      artists: artists.map((artist) => publicArtist(source.id, artist)),
      nextCursor: offset + limit < all.length ? String(offset + limit) : null,
    };
  }

  public async tracks(limit: number, cursor?: string) {
    const source = await this.requireCurrent();
    const offset = parseCursor(cursor);
    const tracks = await this.adapterFor(source).listTracks(
      limit, offset, AbortSignal.timeout(10_000),
    );
    return {
      tracks: tracks.map((track) => publicTrack(source.id, track)),
      nextCursor: tracks.length === limit ? String(offset + tracks.length) : null,
    };
  }

  public async genres() {
    const source = await this.requireCurrent();
    return { genres: await this.adapterFor(source).listGenres(AbortSignal.timeout(10_000)) };
  }

  public async album(reference: string): Promise<AlbumDetail> {
    const { source, remoteId } = await this.resolveReference(reference);
    const album = await this.adapterFor(source).getAlbum(remoteId, AbortSignal.timeout(10_000));
    return {
      ...publicAlbum(source.id, album),
      tracks: album.tracks.map((track) => publicTrack(source.id, track)),
    };
  }

  public async artist(reference: string): Promise<ArtistDetail> {
    const { source, remoteId } = await this.resolveReference(reference);
    const artist = await this.adapterFor(source).getArtist(remoteId, AbortSignal.timeout(10_000));
    return {
      ...publicArtist(source.id, artist),
      albums: artist.albums.map((album) => publicAlbum(source.id, album)),
      biography: artist.biography,
      externalUrl: artist.externalUrl,
      similarArtists: artist.similarArtists.map((item) => publicArtist(source.id, item)),
      topTracks: artist.topTracks.map((track) => publicTrack(source.id, track)),
    };
  }

  public async stream(reference: string, range?: string, signal?: AbortSignal): Promise<SourceMedia> {
    const { source, remoteId } = await this.resolveReference(reference);
    return this.adapterFor(source).getStream(remoteId, range, signal);
  }

  public async cover(reference: string, signal?: AbortSignal): Promise<SourceMedia> {
    const { source, remoteId } = await this.resolveReference(reference);
    return this.adapterFor(source).getCoverArt(remoteId, signal);
  }

  public async lyrics(reference: string, userId: string, signal?: AbortSignal) {
    const { source, remoteId } = await this.resolveReference(reference);
    const adapter = this.adapterFor(source);
    const adjustmentMs = await this.lyricsRepository?.getAdjustment(
      userId, source.id, remoteId,
    ) ?? 0;
    if (this.lyricsProviders.length && this.lyricsRepository) {
      const track = await adapter.getTrack(remoteId, signal);
      const fingerprint = lyricsFingerprint(track);
      for (const provider of this.lyricsProviders) {
        const cached = await this.lyricsRepository.get({
          sourceId: source.id, remoteTrackId: remoteId,
          provider: provider.name, fingerprint,
        });
        if (cached?.length) return { lyrics: cached, adjustmentMs };
        if (cached !== undefined) continue;
        try {
          const providerSignal = signal
            ? AbortSignal.any([signal, AbortSignal.timeout(provider.timeoutMs ?? 8_000)])
            : AbortSignal.timeout(provider.timeoutMs ?? 8_000);
          const found = await provider.find(track, providerSignal);
          await this.lyricsRepository.put({
            sourceId: source.id, remoteTrackId: remoteId,
            provider: provider.name, fingerprint,
            providerItemId: found?.providerItemId,
            instrumental: found?.instrumental,
            document: found?.document ?? null,
          });
          if (found) return { lyrics: [found.document], adjustmentMs };
        } catch {
          // Public providers are best-effort; continue through the configured chain.
        }
      }
    }
    return { lyrics: await adapter.getLyrics(remoteId, signal), adjustmentMs };
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

  public async track(reference: string, signal?: AbortSignal) {
    const { source, remoteId } = await this.resolveReference(reference);
    const track = await this.adapterFor(source).getTrack(remoteId, signal);
    try { await this.catalog?.observeTracks(source.id, [track]); }
    catch { /* Catalog enrichment must never interrupt playback or library browsing. */ }
    return publicTrack(source.id, track);
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

  private async resolveTracks(references: string[]): Promise<Track[]> {
    const results: Array<Track | null> = [];
    for (let index = 0; index < references.length; index += 6) {
      results.push(...await Promise.all(references.slice(index, index + 6).map(async (reference) => {
        try { return await this.track(reference, AbortSignal.timeout(8_000)); }
        catch { return null; }
      })));
    }
    return results.filter((track): track is Track => track !== null);
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
  const { coverArtId, artistId, albumId, ...summary } = track;
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
    favorite: album.favorite,
    playCount: album.playCount,
    lastPlayedAt: normalizeDate(album.lastPlayedAt),
  };
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
