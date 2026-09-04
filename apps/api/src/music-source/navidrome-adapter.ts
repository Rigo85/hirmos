import type { SourceCapability } from '@hirmos/contracts';
import type {
  MusicSourceAdapter,
  SearchResult,
  SourceAlbum,
  SourceAlbumDetail,
  SourceArtist,
  SourceArtistDetail,
  SourceGenre,
  SourceProbeResult,
  SourceLyrics,
  SourceMedia,
  SourceTrack,
} from './music-source-adapter.js';
import { createHash, randomBytes } from 'node:crypto';

export interface NavidromeAdapterOptions {
  baseUrl: URL;
  username: string;
  password: string;
  clientName?: string;
  fetchImplementation?: typeof fetch;
}

interface SubsonicEnvelope<T = Record<string, unknown>> {
  'subsonic-response': {
    status: 'ok' | 'failed';
    version: string;
    type?: string;
    serverVersion?: string;
    error?: { code: number; message?: string };
  } & T;
}

export class NavidromeAdapter implements MusicSourceAdapter {
  private readonly fetchImplementation: typeof fetch;
  private readonly clientName: string;

  public constructor(private readonly options: NavidromeAdapterOptions) {
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    this.clientName = options.clientName ?? 'Hirmos';
  }

  public async probe(signal?: AbortSignal): Promise<SourceProbeResult> {
    const response = await this.call('ping', {}, signal);
    const extensions = await this.call<{
      openSubsonicExtensions?: Array<{ name: string; versions: number[] }>;
    }>('getOpenSubsonicExtensions', {}, signal).catch(() => null);

    const capabilities: SourceCapability[] = [
      'browse',
      'search',
      'coverArt',
      'lyrics',
      'stream',
      'transcode',
      'playlists',
      'scrobble',
    ];
    if (
      extensions?.openSubsonicExtensions?.some(
        (extension) => extension.name === 'songLyrics',
      )
    ) {
      capabilities.push('structuredLyrics');
    }

    return {
      serverType: response.type ?? 'opensubsonic',
      serverVersion: response.serverVersion ?? null,
      apiVersion: response.version,
      capabilities,
    };
  }

  public async search(
    query: string,
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<SearchResult> {
    const offset = parseCursor(cursor);
    const response = await this.call<{
      searchResult3?: {
        artist?: SourceArtistRecord[];
        album?: SourceAlbumRecord[];
        song?: Array<{
          id: string;
          title: string;
          artist?: string;
          artistId?: string;
          album?: string;
          albumId?: string;
          duration?: number;
          coverArt?: string;
          year?: number;
          starred?: string;
        }>;
      };
    }>('search3', {
      query,
      artistCount: '12',
      artistOffset: String(offset),
      albumCount: '12',
      albumOffset: String(offset),
      songCount: '50',
      songOffset: String(offset),
    }, signal);
    const songs = response.searchResult3?.song ?? [];
    return {
      artists: (response.searchResult3?.artist ?? []).map(mapArtist),
      albums: (response.searchResult3?.album ?? []).map(mapAlbum),
      tracks: songs.map(mapSong),
      nextCursor: songs.length === 50 ? String(offset + songs.length) : null,
    };
  }

  public async discover(limit: number, signal?: AbortSignal): Promise<SourceTrack[]> {
    const response = await this.call<{ randomSongs?: { song?: SourceSong[] } }>(
      'getRandomSongs',
      { size: String(Math.min(50, Math.max(1, limit))) },
      signal,
    );
    return (response.randomSongs?.song ?? []).map(mapSong);
  }

  public async listTracks(limit: number, offset = 0, signal?: AbortSignal): Promise<SourceTrack[]> {
    const size = Math.min(100, Math.max(1, limit));
    const response = await this.call<{ searchResult3?: { song?: SourceSong[] } }>(
      'search3',
      {
        query: '', artistCount: '0', albumCount: '0', songCount: String(size),
        songOffset: String(Math.max(0, offset)),
      },
      signal,
    );
    return (response.searchResult3?.song ?? []).map(mapSong);
  }

  public async listAlbums(
    type: 'random' | 'newest' | 'frequent' | 'recent' | 'alphabeticalByName',
    limit: number,
    offset = 0,
    signal?: AbortSignal,
  ): Promise<SourceAlbum[]> {
    const size = Math.min(100, Math.max(1, limit));
    const response = await this.call<{ albumList2?: { album?: SourceAlbumRecord[] } }>(
      'getAlbumList2',
      { type, size: String(size), offset: String(Math.max(0, offset)) },
      signal,
    );
    return (response.albumList2?.album ?? []).map(mapAlbum);
  }

  public async listArtists(signal?: AbortSignal): Promise<SourceArtist[]> {
    const response = await this.call<{
      artists?: { index?: Array<{ artist?: SourceArtistRecord[] }> };
    }>('getArtists', {}, signal);
    return (response.artists?.index ?? []).flatMap((index) => index.artist ?? []).map(mapArtist);
  }

  public async listGenres(signal?: AbortSignal): Promise<SourceGenre[]> {
    const response = await this.call<{
      genres?: { genre?: Array<{ value?: string; songCount?: number; albumCount?: number }> };
    }>('getGenres', {}, signal);
    return (response.genres?.genre ?? []).map((genre) => ({
      name: genre.value ?? 'Sin género',
      songCount: Math.max(0, genre.songCount ?? 0),
      albumCount: Math.max(0, genre.albumCount ?? 0),
    }));
  }

  public async getAlbum(albumId: string, signal?: AbortSignal): Promise<SourceAlbumDetail> {
    const response = await this.call<{ album?: SourceAlbumRecord & { song?: SourceSong[] } }>(
      'getAlbum', { id: albumId }, signal,
    );
    if (!response.album) throw new Error('Music source did not return the album');
    return { ...mapAlbum(response.album), tracks: (response.album.song ?? []).map(mapSong) };
  }

  public async getArtist(artistId: string, signal?: AbortSignal): Promise<SourceArtistDetail> {
    const response = await this.call<{ artist?: SourceArtistRecord & { album?: SourceAlbumRecord[] } }>(
      'getArtist', { id: artistId }, signal,
    );
    if (!response.artist) throw new Error('Music source did not return the artist');
    const [info, topSongs] = await Promise.all([
      this.call<{
        artistInfo2?: {
          biography?: string;
          lastFmUrl?: string;
          similarArtist?: SourceArtistRecord[];
        };
      }>('getArtistInfo2', {
        id: artistId, count: '12', includeNotPresent: 'false',
      }, signal).catch(() => null),
      this.call<{ topSongs?: { song?: SourceSong[] } }>(
        'getTopSongs', { artist: response.artist.name, count: '50' }, signal,
      ).catch(() => null),
    ]);
    return {
      ...mapArtist(response.artist),
      albums: (response.artist.album ?? []).map(mapAlbum),
      biography: cleanExternalText(info?.artistInfo2?.biography),
      externalUrl: normalizeExternalUrl(info?.artistInfo2?.lastFmUrl),
      similarArtists: (info?.artistInfo2?.similarArtist ?? [])
        .filter((artist) => Boolean(artist.id && artist.name))
        .map(mapArtist),
      topTracks: (topSongs?.topSongs?.song ?? []).map(mapSong),
    };
  }

  public getStream(trackId: string, range?: string, signal?: AbortSignal): Promise<SourceMedia> {
    return this.media('stream', { id: trackId }, range ? { range } : {}, signal);
  }

  public getCoverArt(coverArtId: string, signal?: AbortSignal): Promise<SourceMedia> {
    return this.media('getCoverArt', { id: coverArtId }, {}, signal);
  }

  public async getLyrics(trackId: string, signal?: AbortSignal): Promise<SourceLyrics[]> {
    const structured = await this.call<{
      lyricsList?: {
        structuredLyrics?: Array<{
          displayArtist?: string;
          displayTitle?: string;
          lang?: string;
          offset?: number;
          synced?: boolean;
          line?: Array<{ start?: number; value?: string }>;
        }>;
      };
    }>('getLyricsBySongId', { id: trackId }, signal).catch(() => null);
    const documents = (structured?.lyricsList?.structuredLyrics ?? []).map((lyrics) => {
      const offsetMs = typeof lyrics.offset === 'number' ? lyrics.offset : 0;
      return {
        displayArtist: lyrics.displayArtist ?? null,
        displayTitle: lyrics.displayTitle ?? null,
        language: lyrics.lang && lyrics.lang !== 'xxx' ? lyrics.lang : null,
        synced: Boolean(lyrics.synced),
        lines: (lyrics.line ?? []).map((line) => ({
          startMs: typeof line.start === 'number'
            ? Math.max(0, line.start - offsetMs)
            : null,
          text: line.value ?? '',
        })),
      };
    });
    if (documents.length) return documents;

    const song = await this.getTrack(trackId, signal);
    const legacy = await this.call<{ lyrics?: { artist?: string; title?: string; value?: string } }>(
      'getLyrics',
      { artist: song.artist, title: song.title },
      signal,
    ).catch(() => null);
    const text = legacy?.lyrics?.value?.trim();
    if (!text) return [];
    return [{
      displayArtist: legacy?.lyrics?.artist ?? song.artist,
      displayTitle: legacy?.lyrics?.title ?? song.title,
      language: null,
      synced: false,
      lines: text.split(/\r?\n/).map((line) => ({ startMs: null, text: line })),
    }];
  }

  public async getTrack(trackId: string, signal?: AbortSignal): Promise<SourceTrack> {
    const response = await this.call<{ song?: SourceSong }>('getSong', { id: trackId }, signal);
    if (!response.song) throw new Error('Music source did not return the song');
    return mapSong(response.song);
  }

  private async call<T extends Record<string, unknown> = Record<string, unknown>>(
    endpoint: string,
    parameters: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<SubsonicEnvelope<T>['subsonic-response']> {
    const url = this.url(endpoint, parameters);

    const httpResponse = await this.fetchImplementation(url, {
      signal,
      headers: { accept: 'application/json' },
    });
    if (!httpResponse.ok) {
      throw new Error(`Music source returned HTTP ${httpResponse.status}`);
    }
    const envelope = (await httpResponse.json()) as SubsonicEnvelope<T>;
    const response = envelope['subsonic-response'];
    if (!response || response.status !== 'ok') {
      throw new Error(`Music source rejected the request (${response?.error?.code ?? 'unknown'})`);
    }
    return response;
  }

  private async media(
    endpoint: string,
    parameters: Record<string, string>,
    headers: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<SourceMedia> {
    const response = await this.fetchImplementation(this.url(endpoint, parameters), {
      signal,
      headers,
    });
    if (!response.ok || !response.body) {
      throw new Error(`Music source returned HTTP ${response.status}`);
    }
    return {
      status: response.status,
      body: response.body,
      contentType: response.headers.get('content-type'),
      contentLength: response.headers.get('content-length'),
      contentRange: response.headers.get('content-range'),
      acceptRanges: response.headers.get('accept-ranges'),
    };
  }

  private url(endpoint: string, parameters: Record<string, string>): URL {
    const salt = randomBytes(12).toString('hex');
    const token = subsonicToken(this.options.password, salt);
    const url = new URL(`/rest/${endpoint}.view`, this.options.baseUrl);
    url.search = new URLSearchParams({
      u: this.options.username,
      t: token,
      s: salt,
      v: '1.16.1',
      c: this.clientName,
      f: 'json',
      ...parameters,
    }).toString();
    return url;
  }
}

function subsonicToken(password: string, salt: string): string {
  return createHash('md5').update(password + salt, 'utf8').digest('hex');
}

function parseCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const parsed = Number.parseInt(cursor, 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

interface SourceSong {
  id: string;
  title: string;
  artist?: string;
  artistId?: string;
  album?: string;
  albumId?: string;
  duration?: number;
  coverArt?: string;
  year?: number;
  starred?: string;
}

function mapSong(song: SourceSong): SourceTrack {
  return {
    id: song.id,
    title: song.title,
    artist: song.artist ?? 'Artista desconocido',
    artistId: song.artistId ?? null,
    album: song.album ?? 'Álbum desconocido',
    albumId: song.albumId ?? null,
    durationMs: Math.max(0, Math.round((song.duration ?? 0) * 1_000)),
    coverArtId: song.coverArt ?? null,
    year: song.year ?? null,
    favorite: Boolean(song.starred),
  };
}

interface SourceArtistRecord {
  id: string;
  name: string;
  coverArt?: string;
  albumCount?: number;
  starred?: string;
}

interface SourceAlbumRecord {
  id: string;
  name?: string;
  title?: string;
  album?: string;
  artist?: string;
  artistId?: string;
  coverArt?: string;
  songCount?: number;
  duration?: number;
  year?: number;
  genre?: string;
  starred?: string;
  playCount?: number;
  played?: string;
}

function mapArtist(artist: SourceArtistRecord): SourceArtist {
  return {
    id: artist.id,
    name: artist.name,
    coverArtId: artist.coverArt ?? null,
    albumCount: Math.max(0, artist.albumCount ?? 0),
    favorite: Boolean(artist.starred),
  };
}

function mapAlbum(album: SourceAlbumRecord): SourceAlbum {
  return {
    id: album.id,
    name: album.name ?? album.title ?? album.album ?? 'Álbum desconocido',
    artist: album.artist ?? 'Artista desconocido',
    artistId: album.artistId ?? null,
    coverArtId: album.coverArt ?? null,
    songCount: Math.max(0, album.songCount ?? 0),
    durationMs: Math.max(0, Math.round((album.duration ?? 0) * 1_000)),
    year: album.year ?? null,
    genre: album.genre ?? null,
    favorite: Boolean(album.starred),
    playCount: typeof album.playCount === 'number' ? Math.max(0, album.playCount) : null,
    lastPlayedAt: album.played ?? null,
  };
}

function cleanExternalText(value: string | undefined): string | null {
  if (!value) return null;
  const cleaned = value
    .replace(/<a\b[^>]*>\s*Read more(?:\s+on Last\.fm)?\s*<\/a>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned ? cleaned.slice(0, 5_000) : null;
}

function normalizeExternalUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}
