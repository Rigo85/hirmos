import type { SourceTrack } from '../music-source/music-source-adapter.js';
import { fetchWithRetry, type ThirdPartyTelemetry } from '../integrations/third-party-request.js';
import type { LyricsProvider, PublicLyricsResult } from './lyrics-provider.js';
import { editorialAlbum, isLrclibResponse, mismatch, sameAlbum, type LrclibResponse } from './lrclib-match.js';

interface Lookup {
  controller: AbortController;
  promise: Promise<PublicLyricsResult | null>;
  subscribers: number;
}

export class LrclibLyricsProvider implements LyricsProvider {
  public readonly name = 'lrclib';
  public readonly negativeCacheVersion = 'lrclib-lookup-v2';
  private readonly pending = new Map<string, Lookup>();

  public constructor(
    private readonly fetchImplementation: typeof fetch = fetch,
    private readonly telemetry?: ThirdPartyTelemetry,
  ) {}

  public async find(track: SourceTrack, signal?: AbortSignal): Promise<PublicLyricsResult | null> {
    signal?.throwIfAborted();
    const key = JSON.stringify([track.title, track.artist, track.album, track.durationMs]);
    let lookup = this.pending.get(key);
    if (!lookup) {
      const controller = new AbortController();
      lookup = { controller, subscribers: 0, promise: this.lookup(track, controller.signal) };
      this.pending.set(key, lookup);
      const current = lookup;
      void lookup.promise.finally(() => {
        if (this.pending.get(key) === current) this.pending.delete(key);
      }).catch(() => undefined);
    }
    const current = lookup;
    current.subscribers += 1;
    // One caller leaving must not cancel another caller's lookup. No user data
    // or adjustments are shared here, only public metadata and provider results.
    return new Promise((resolve, reject) => {
      let finished = false;
      const finish = (result?: PublicLyricsResult | null, error?: unknown) => {
        if (finished) return;
        finished = true;
        signal?.removeEventListener('abort', abort);
        current.subscribers -= 1;
        if (!current.subscribers) {
          if (this.pending.get(key) === current) this.pending.delete(key);
          current.controller.abort();
        }
        if (error !== undefined) reject(error); else resolve(result ?? null);
      };
      const abort = () => finish(undefined, signal?.reason);
      signal?.addEventListener('abort', abort, { once: true });
      current.promise.then((result) => finish(result), (error: unknown) => finish(undefined, error));
      if (signal?.aborted) abort();
    });
  }

  private decision(stage: string, reason: string, outcome: 'success' | 'not_found' | 'failure'): void {
    this.telemetry?.record({ provider: this.name, operation: `match:${stage}:${reason}`,
      attempt: 1, maxAttempts: 1, elapsedMs: 0, outcome });
  }

  private async lookup(track: SourceTrack, callerSignal: AbortSignal): Promise<PublicLyricsResult | null> {
    const deadline = Date.now() + 6_500;
    const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(6_500)]);
    let requests = 0;
    let retries = 0;
    const request = async (operation: 'get' | 'search', album: string): Promise<unknown | null> => {
      signal.throwIfAborted();
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new DOMException('LRCLIB lookup budget expired', 'TimeoutError');
      const url = new URL(`https://lrclib.net/api/${operation}`);
      url.search = new URLSearchParams({ track_name: track.title, artist_name: track.artist,
        ...(operation === 'get' ? { album_name: album,
          duration: String(Math.max(0, Math.round(track.durationMs / 1_000))) } : {}),
      }).toString();
      let attempts = 0;
      const response = await fetchWithRetry(async (input, init) => {
        if (attempts++ > 0) retries += 1;
        requests += 1;
        if (requests > 4) throw new Error('LRCLIB request limit exceeded');
        const response = await this.fetchImplementation(input, init);
        if (!response.ok) return response;
        // Consume the body inside the retry/deadline scope, not after it. A
        // broken or oversized search response must not become a cached miss.
        const reader = response.body?.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        const abortBody = () => { void reader?.cancel().catch(() => undefined); };
        init?.signal?.addEventListener('abort', abortBody, { once: true });
        try {
          if (reader) while (true) {
            init?.signal?.throwIfAborted();
            const { value, done } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > 2 * 1024 * 1024) throw new Error('LRCLIB response size limit exceeded');
            chunks.push(value);
          }
        } finally {
          init?.signal?.removeEventListener('abort', abortBody);
          await reader?.cancel().catch(() => undefined);
        }
        init?.signal?.throwIfAborted();
        return new Response(Buffer.concat(chunks), { status: response.status });
      }, url, { headers: { accept: 'application/json',
        'user-agent': 'Hirmos/0.1 (OpenSubsonic web player)' } }, {
        provider: this.name, operation, signal, attemptTimeoutMs: 2_500,
        totalTimeoutMs: remaining, maxAttempts: retries ? 1 : 2, telemetry: this.telemetry,
      });
      if (response.status === 404 && operation === 'get') {
        await response.body?.cancel();
        return null;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`LRCLIB returned HTTP ${response.status}`);
      }
      return response.json();
    };
    const albums = [...new Set([track.album, editorialAlbum(track.album)])];
    let uncertain = false;
    for (const [index, album] of albums.entries()) {
      const stage = index ? 'editorial' : 'exact';
      const value = await request('get', album);
      if (value === null) continue;
      if (!isLrclibResponse(value)) throw new Error('Invalid LRCLIB metadata response');
      const reason = mismatch(track, value);
      if (reason) {
        uncertain = true;
        this.decision(stage, reason, 'not_found');
        continue;
      }
      const result = toResult(value);
      if (result) { this.decision(stage, 'accepted', 'success'); return result; }
    }
    const values = await request('search', track.album);
    if (!Array.isArray(values) || values.length > 20 || !values.every(isLrclibResponse)) {
      throw new Error('Invalid LRCLIB search response');
    }
    const candidates: Array<{ metadata: LrclibResponse; result: PublicLyricsResult }> = [];
    for (const value of values) {
      const reason = mismatch(track, value);
      if (reason) { this.decision('search', reason, 'not_found'); continue; }
      const result = toResult(value);
      if (result) candidates.push({ metadata: value, result });
    }
    // Prefer a matching album, never synchronization quality over identity.
    const albumMatches = candidates.filter(({ metadata }) => sameAlbum(track, metadata));
    const shortlist = albumMatches.length ? albumMatches : candidates;
    const documents = new Set(shortlist.map(({ result }) => JSON.stringify({
      instrumental: result.instrumental, synced: result.document.synced, lines: result.document.lines,
    })));
    if (documents.size > 1 || (!shortlist.length && (uncertain || values.length === 20))) {
      this.decision('search', 'ambiguous_or_truncated', 'failure');
      throw new Error('LRCLIB could not establish a reliable match');
    }
    // Equivalent documents may have several provider IDs; choose stably.
    const selected = shortlist.sort((a, b) => a.metadata.id - b.metadata.id)[0];
    this.decision('search', selected ? 'accepted' : 'no_match', selected ? 'success' : 'not_found');
    return selected?.result ?? null;
  }
}

function toResult(lyrics: LrclibResponse): PublicLyricsResult | null {
    const syncedLines = parseLrc(lyrics.syncedLyrics ?? '');
    const plainLines = (lyrics.plainLyrics ?? '').split(/\r?\n/)
      .map((text) => ({ startMs: null, text }))
      .filter((line) => line.text.trim().length > 0);
    const lines = syncedLines.length ? syncedLines : plainLines;
    if (!lines.length && !lyrics.instrumental) return null;
    return {
      providerItemId: lyrics.id === undefined ? null : String(lyrics.id),
      instrumental: Boolean(lyrics.instrumental),
      raw: {
        content: JSON.stringify(lyrics),
        contentType: 'application/json',
        parserVersion: 'lrclib-json-v1',
      },
      document: {
        displayArtist: lyrics.artistName,
        displayTitle: lyrics.trackName,
        language: null,
        synced: syncedLines.length > 0,
        lines: lyrics.instrumental && !lines.length
          ? [{ startMs: null, text: 'Instrumental' }]
          : lines,
      },
    };
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
