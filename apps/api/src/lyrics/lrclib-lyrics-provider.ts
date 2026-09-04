import type { SourceTrack } from '../music-source/music-source-adapter.js';
import type { LyricsProvider, PublicLyricsResult } from './lyrics-provider.js';

interface LrclibResponse {
  id?: number;
  trackName?: string;
  artistName?: string;
  instrumental?: boolean;
  plainLyrics?: string | null;
  syncedLyrics?: string | null;
}

export class LrclibLyricsProvider implements LyricsProvider {
  public readonly name = 'lrclib';

  public constructor(private readonly fetchImplementation: typeof fetch = fetch) {}

  public async find(track: SourceTrack, signal?: AbortSignal): Promise<PublicLyricsResult | null> {
    const url = new URL('https://lrclib.net/api/get');
    url.search = new URLSearchParams({
      track_name: track.title,
      artist_name: track.artist,
      album_name: track.album,
      duration: String(Math.max(0, Math.round(track.durationMs / 1_000))),
    }).toString();
    const response = await this.fetchImplementation(url, {
      signal,
      headers: {
        accept: 'application/json',
        'user-agent': 'Hirmos/0.1 (OpenSubsonic web player)',
      },
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`LRCLIB returned HTTP ${response.status}`);
    const lyrics = await response.json() as LrclibResponse;
    const syncedLines = parseLrc(lyrics.syncedLyrics ?? '');
    const plainLines = (lyrics.plainLyrics ?? '').split(/\r?\n/)
      .map((text) => ({ startMs: null, text }))
      .filter((line) => line.text.trim().length > 0);
    const lines = syncedLines.length ? syncedLines : plainLines;
    if (!lines.length && !lyrics.instrumental) return null;
    return {
      providerItemId: lyrics.id === undefined ? null : String(lyrics.id),
      instrumental: Boolean(lyrics.instrumental),
      document: {
        displayArtist: lyrics.artistName ?? track.artist,
        displayTitle: lyrics.trackName ?? track.title,
        language: null,
        synced: syncedLines.length > 0,
        lines: lyrics.instrumental && !lines.length
          ? [{ startMs: null, text: 'Instrumental' }]
          : lines,
      },
    };
  }
}

export function parseLrc(value: string): Array<{ startMs: number; text: string }> {
  const lines: Array<{ startMs: number; text: string }> = [];
  const offsetMatch = value.match(/^\s*\[offset:([+-]?\d+)\]\s*$/im);
  const offsetMs = offsetMatch ? Number(offsetMatch[1]) : 0;
  for (const row of value.split(/\r?\n/)) {
    const matches = [...row.matchAll(/\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
    if (!matches.length) continue;
    const text = row.replace(/\[[^\]]+\]/g, '').trim();
    for (const match of matches) {
      const fraction = (match[3] ?? '').padEnd(3, '0').slice(0, 3);
      lines.push({
        startMs: Math.max(0,
          Number(match[1]) * 60_000 + Number(match[2]) * 1_000
            + Number(fraction || 0) - offsetMs),
        text,
      });
    }
  }
  return lines.sort((left, right) => left.startMs - right.startMs);
}
