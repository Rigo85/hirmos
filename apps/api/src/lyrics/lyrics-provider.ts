import type { SourceLyrics, SourceTrack } from '../music-source/music-source-adapter.js';
import type { RawLyricsDocument } from '../cache/lyrics-object-cache.js';

export interface PublicLyricsResult {
  providerItemId: string | null;
  instrumental: boolean;
  document: SourceLyrics;
  raw?: RawLyricsDocument;
}

export interface LyricsProvider {
  readonly name: string;
  readonly timeoutMs?: number;
  /** Only invalidates negative results from an older lookup strategy. */
  readonly negativeCacheVersion?: string;
  find(track: SourceTrack, signal?: AbortSignal): Promise<PublicLyricsResult | null>;
}
