import type { SourceLyrics, SourceTrack } from '../music-source/music-source-adapter.js';

export interface PublicLyricsResult {
  providerItemId: string | null;
  instrumental: boolean;
  document: SourceLyrics;
}

export interface LyricsProvider {
  readonly name: string;
  readonly timeoutMs?: number;
  find(track: SourceTrack, signal?: AbortSignal): Promise<PublicLyricsResult | null>;
}
