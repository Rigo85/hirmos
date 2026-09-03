import type {
  AdminMusicSource, Album, AlbumDetail, Artist, ArtistDetail, LibraryHomeResponse,
  SearchResponse, Track,
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
import type { ActivityRepository } from '../activity/activity-repository.js';
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
    private readonly lyricsProvider?: LyricsProvider,
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
    const [recentRefs, mostRefs, newest, rediscover] = await Promise.all([
      this.activity?.recentTrackReferences(userId, 10) ?? [],
      this.activity?.mostPlayedTrackReferences(userId, 10) ?? [],
      adapter.listAlbums('newest', 10, 0, AbortSignal.timeout(10_000)),
      adapter.listAlbums('random', 10, 0, AbortSignal.timeout(10_000)),
    ]);
    const [recentlyPlayed, mostPlayed] = await Promise.all([
      this.resolveTracks(recentRefs), this.resolveTracks(mostRefs),
    ]);
    return {
      recentlyPlayed,
      mostPlayed,
      recentlyAdded: newest.map((album) => publicAlbum(source.id, album)),
      rediscover: rediscover.map((album) => publicAlbum(source.id, album)),
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

  public async lyrics(reference: string, signal?: AbortSignal) {
    const { source, remoteId } = await this.resolveReference(reference);
    const adapter = this.adapterFor(source);
    if (this.lyricsProvider && this.lyricsRepository) {
      const track = await adapter.getTrack(remoteId, signal);
      const fingerprint = lyricsFingerprint(track);
      const cached = await this.lyricsRepository.get({
        sourceId: source.id, remoteTrackId: remoteId,
        provider: this.lyricsProvider.name, fingerprint,
      });
      if (cached?.length) return { lyrics: cached };
      if (cached === undefined) {
        try {
          const providerSignal = signal
            ? AbortSignal.any([signal, AbortSignal.timeout(8_000)])
            : AbortSignal.timeout(8_000);
          const found = await this.lyricsProvider.find(track, providerSignal);
          await this.lyricsRepository.put({
            sourceId: source.id, remoteTrackId: remoteId,
            provider: this.lyricsProvider.name, fingerprint,
            providerItemId: found?.providerItemId,
            instrumental: found?.instrumental,
            document: found?.document ?? null,
          });
          if (found) return { lyrics: [found.document] };
        } catch {
          // Public providers are best-effort; the source remains the reliable fallback.
        }
      }
    }
    return { lyrics: await adapter.getLyrics(remoteId, signal) };
  }

  public async track(reference: string, signal?: AbortSignal) {
    const { source, remoteId } = await this.resolveReference(reference);
    const track = await this.adapterFor(source).getTrack(remoteId, signal);
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
    const results = await Promise.all(references.map(async (reference) => {
      try { return await this.track(reference, AbortSignal.timeout(8_000)); }
      catch { return null; }
    }));
    return results.filter((track): track is Track => track !== null);
  }
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
