import type { SourceCapability } from '@hirmos/contracts';

export interface SourceProbeResult {
  serverType: string;
  serverVersion: string | null;
  apiVersion: string;
  capabilities: SourceCapability[];
}

export interface SearchResult {
  artists: SourceArtist[];
  albums: SourceAlbum[];
  tracks: SourceTrack[];
  nextCursor: string | null;
}

export interface SourceArtist {
  id: string;
  name: string;
  coverArtId: string | null;
  albumCount: number;
  favorite: boolean;
  musicBrainzId: string | null;
}

export interface SourceAlbum {
  id: string;
  name: string;
  artist: string;
  artistId: string | null;
  coverArtId: string | null;
  songCount: number;
  durationMs: number;
  year: number | null;
  genre: string | null;
  genres: string[];
  musicBrainzId: string | null;
  favorite: boolean;
  playCount: number | null;
  lastPlayedAt: string | null;
}

export interface SourceGenre {
  name: string;
  albumCount: number;
  songCount: number;
}

export interface SourceAlbumDetail extends SourceAlbum { tracks: SourceTrack[] }
export interface SourceArtistDetail extends SourceArtist {
  albums: SourceAlbum[];
  biography: string | null;
  externalUrl: string | null;
  similarArtists: SourceArtist[];
  topTracks: SourceTrack[];
}

export interface SourceTrack {
  id: string;
  title: string;
  artist: string;
  artistId: string | null;
  album: string;
  albumId: string | null;
  durationMs: number;
  coverArtId: string | null;
  year: number | null;
  genres: string[];
  musicBrainzId: string | null;
  favorite: boolean;
}

export interface SourceMedia {
  status: number;
  body: ReadableStream<Uint8Array>;
  contentType: string | null;
  contentLength: string | null;
  contentRange: string | null;
  acceptRanges: string | null;
}

export interface SourceLyrics {
  displayArtist: string | null;
  displayTitle: string | null;
  language: string | null;
  synced: boolean;
  lines: Array<{
    startMs: number | null;
    endMs?: number | null;
    text: string;
    words?: Array<{ startMs: number; endMs: number | null; text: string }>;
  }>;
}

export interface MusicSourceAdapter {
  probe(signal?: AbortSignal): Promise<SourceProbeResult>;
  search(query: string, cursor?: string, signal?: AbortSignal): Promise<SearchResult>;
  discover(limit: number, signal?: AbortSignal): Promise<SourceTrack[]>;
  listTracks(limit: number, offset?: number, signal?: AbortSignal): Promise<SourceTrack[]>;
  listAlbums(type: 'random' | 'newest' | 'frequent' | 'recent' | 'alphabeticalByName', limit: number, offset?: number, signal?: AbortSignal): Promise<SourceAlbum[]>;
  listArtists(signal?: AbortSignal): Promise<SourceArtist[]>;
  listGenres(signal?: AbortSignal): Promise<SourceGenre[]>;
  listAlbumsByGenre(genre: string, limit: number, offset?: number, signal?: AbortSignal): Promise<SourceAlbum[]>;
  listTracksByGenre(genre: string, limit: number, offset?: number, signal?: AbortSignal): Promise<SourceTrack[]>;
  listAlbumsByYear(year: number, limit: number, offset?: number, signal?: AbortSignal): Promise<SourceAlbum[]>;
  getAlbum(albumId: string, signal?: AbortSignal): Promise<SourceAlbumDetail>;
  getArtist(artistId: string, signal?: AbortSignal): Promise<SourceArtistDetail>;
  getStream(trackId: string, range?: string, signal?: AbortSignal): Promise<SourceMedia>;
  getCoverArt(coverArtId: string, signal?: AbortSignal): Promise<SourceMedia>;
  getLyrics(trackId: string, signal?: AbortSignal): Promise<SourceLyrics[]>;
  getTrack(trackId: string, signal?: AbortSignal): Promise<SourceTrack>;
}
