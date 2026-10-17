import { afterEach, describe, expect, it, vi } from 'vitest';
import { LrclibLyricsProvider, parseLrc } from '../src/lyrics/lrclib-lyrics-provider.js';
import { editorialAlbum } from '../src/lyrics/lrclib-match.js';
import { ThirdPartyTelemetry } from '../src/integrations/third-party-request.js';

const track = {
  id: 'one', title: 'Canción', artist: 'Artista', artistId: null,
  album: 'Álbum', albumId: null, durationMs: 215_000, coverArtId: null,
  year: null, favorite: false,
};

describe('LrclibLyricsProvider', () => {
  it('sends complete metadata and maps synchronized lyrics', async () => {
    let requested: URL | null = null;
    const provider = new LrclibLyricsProvider(vi.fn(async (input) => {
      requested = new URL(String(input));
      return Response.json({
        id: 7, trackName: 'Canción', artistName: 'Artista',
        albumName: 'Álbum', duration: 215,
        syncedLyrics: '[00:01.25]Primera\n[01:02.003]Segunda', plainLyrics: null,
      });
    }) as typeof fetch);
    const result = await provider.find(track);
    expect(requested!.searchParams.get('duration')).toBe('215');
    expect(requested!.searchParams.get('album_name')).toBe('Álbum');
    expect(result?.document.synced).toBe(true);
    expect(result?.document.lines).toEqual([
      { startMs: 1_250, text: 'Primera' },
      { startMs: 62_003, text: 'Segunda' },
    ]);
  });

  it('treats a 404 as a normal miss', async () => {
    const provider = new LrclibLyricsProvider(vi.fn(async (url) => String(url).includes('/search?')
      ? Response.json([]) : new Response(null, { status: 404 })) as typeof fetch);
    await expect(provider.find(track)).resolves.toBeNull();
  });

  it('retries a transient upstream failure once', async () => {
    const fetchImplementation = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(Response.json({
        id: 8, trackName: 'Canción', artistName: 'Artista',
        albumName: 'Álbum', duration: 215,
        syncedLyrics: '[00:01.00]Recuperada', plainLyrics: null,
      }));
    const provider = new LrclibLyricsProvider(fetchImplementation as typeof fetch);

    const result = await provider.find(track);

    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    expect(result?.providerItemId).toBe('8');
  });
});

const candidate = (overrides = {}) => ({ id: 1, trackName: track.title, artistName: track.artist,
  albumName: track.album, duration: 215, syncedLyrics: '[00:01]Una línea', ...overrides });
const miss = () => new Response(null, { status: 404 });
const editedTrack = { ...track, album: 'Álbum (Example Records - ABC 1234, EU, 1987)' };
const fixture = (...responses: Array<() => Response>) => {
  const fetcher = vi.fn();
  for (const response of responses) fetcher.mockImplementationOnce(async () => response());
  return { fetcher, provider: new LrclibLyricsProvider(fetcher as typeof fetch) };
};

describe('LRCLIB bounded fallback and identity', () => {
  afterEach(() => vi.useRealTimers());

  it('tries original then editorial album and stops on a validated exact match', async () => {
    const { provider, fetcher } = fixture(miss, () => Response.json(candidate({ duration: 217 })));
    expect((await provider.find(editedTrack))?.providerItemId).toBe('1');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(new URL(String(fetcher.mock.calls[0]![0])).searchParams.get('album_name')).toBe(editedTrack.album);
    expect(new URL(String(fetcher.mock.calls[1]![0])).searchParams.get('album_name')).toBe('Álbum');
  });

  it.each(['Album (Live)', 'Album (2011 Remastered)', 'Album (Acoustic)', 'Album (Unknown)',
    'Album (Radio Edit)', 'Album (Instrumental)', 'Album (Re-recorded)', 'Album (Deluxe Edition)'])(
    'preserves unrecognized/musical edition %s', (album) => expect(editorialAlbum(album)).toBe(album));

  it('searches only after both exact misses; no extra fetch per candidate', async () => {
    const { provider, fetcher } = fixture(miss, miss, () => Response.json([candidate()]));
    expect((await provider.find(editedTrack))?.document.synced).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(3);
    const url = new URL(String(fetcher.mock.calls[2]![0]));
    expect(url.pathname).toBe('/api/search');
    expect([...url.searchParams.keys()]).toEqual(['track_name', 'artist_name']);
  });

  it.each([
    { artistName: 'Other' }, { trackName: 'Canción (Live)' }, { duration: 218 },
    { duration: 212.99 }, { albumName: 'Live at the Arena' }, { albumName: 'Album Remastered' },
  ])('rejects a conflicting search candidate %j', async (override) => {
    const { provider } = fixture(miss, () => Response.json([candidate(override)]));
    expect(await provider.find(track)).toBeNull();
  });

  it('rejects even a successful exact response with wrong metadata, without caching absence', async () => {
    const { provider } = fixture(() => Response.json(candidate({ artistName: 'Other' })), () => Response.json([]));
    await expect(provider.find(track)).rejects.toThrow('reliable match');
  });

  it('does not infer synchronization equivalence from a remaster label', async () => {
    const { provider } = fixture(miss, () => Response.json([candidate()]));
    expect(await provider.find({ ...track, title: 'Canción (Remastered)' })).toBeNull();
  });

  it('accepts equivalent duplicates deterministically, not the first search result', async () => {
    const { provider } = fixture(miss, () => Response.json([candidate({ id: 12 }), candidate({ id: 4 })]));
    expect((await provider.find(track))?.providerItemId).toBe('4');
  });

  it('rejects conflicting documents instead of selecting the first or best timed one', async () => {
    const { provider } = fixture(miss, () => Response.json([
      candidate(), candidate({ id: 2, syncedLyrics: '[00:05]Otra línea' }),
    ]));
    await expect(provider.find(track)).rejects.toThrow('reliable match');
  });

  it('prefers album identity over a synchronized compilation candidate', async () => {
    const { provider } = fixture(miss, () => Response.json([
      candidate({ id: 2, albumName: 'Compilation' }),
      candidate({ syncedLyrics: null, plainLyrics: 'Una línea' }),
    ]));
    expect((await provider.find(track))?.document.synced).toBe(false);
  });

  it('does not call a truncated search with no match definitive absence', async () => {
    const { provider } = fixture(miss, () => Response.json(Array.from({ length: 20 }, (_, id) =>
      candidate({ id: id + 1, duration: 400 }))));
    await expect(provider.find(track)).rejects.toThrow('reliable match');
  });

  it('falls through an empty lyric to search; accepts an explicitly instrumental match', async () => {
    const { provider } = fixture(() => Response.json(candidate({ syncedLyrics: null })),
      () => Response.json([candidate({ syncedLyrics: null, instrumental: true })]));
    expect((await provider.find(track))?.instrumental).toBe(true);
  });

  it.each([null, {}, [candidate({ duration: undefined })]])('rejects malformed search payload %j', async (body) => {
    const { provider } = fixture(miss, () => Response.json(body));
    await expect(provider.find(track)).rejects.toThrow('Invalid LRCLIB');
  });

  it('stops the provider after persistent 503, honoring Retry-After', async () => {
    vi.useFakeTimers();
    const { provider, fetcher } = fixture(
      () => new Response(null, { status: 503, headers: { 'Retry-After': '1' } }),
      () => new Response(null, { status: 503 }));
    const result = expect(provider.find(editedTrack)).rejects.toThrow('HTTP 503');
    await vi.advanceTimersByTimeAsync(999);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await result;
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('shares one retry across stages, not two attempts for every query', async () => {
    vi.useFakeTimers();
    const { provider, fetcher } = fixture(
      () => new Response(null, { status: 503, headers: { 'Retry-After': '0' } }), miss, miss,
      () => new Response(null, { status: 503 }));
    await expect(provider.find(editedTrack)).rejects.toThrow('HTTP 503');
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('does not reset the total deadline between stages', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(async (url) => {
      if (String(url).includes('/get?')) { vi.setSystemTime(Date.now() + 3_000); return miss(); }
      return new Response(null, { status: 503, headers: { 'Retry-After': '1' } });
    });
    await expect(new LrclibLyricsProvider(fetcher as typeof fetch).find(editedTrack)).rejects.toThrow('503');
    expect(fetcher).toHaveBeenCalledTimes(3); // only 500 ms left, cannot wait Retry-After
  });

  it('bounds response bodies', async () => {
    const { provider } = fixture(() => new Response('x'.repeat(2 * 1024 * 1024 + 1)));
    await expect(provider.find(track)).rejects.toThrow('size limit');
  });

  it('does not retry permanent HTTP errors or try alternate metadata after them', async () => {
    const { provider, fetcher } = fixture(() => new Response(null, { status: 403 }));
    await expect(provider.find(editedTrack)).rejects.toThrow('HTTP 403');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('aborts a stalled body within the shared time budget', async () => {
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => realTimeout(Math.min(ms, 20)));
    const cancel = vi.fn();
    const { provider, fetcher } = fixture(() => new Response(new ReadableStream({ cancel })));
    try {
      await expect(provider.find(track)).rejects.toMatchObject({ name: 'TimeoutError' });
      expect(cancel).toHaveBeenCalled();
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally { timeout.mockRestore(); }
  });

  it('cancels a body read and never falls through to another query', async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const { provider, fetcher } = fixture(() => new Response(new ReadableStream({
      start() { queueMicrotask(() => controller.abort()); }, cancel,
    })));
    await expect(provider.find(track, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalled();
  });

  it('coalesces concurrent callers without sharing their cancellation', async () => {
    let release!: (response: Response) => void;
    const fetcher = vi.fn(() => new Promise<Response>((resolve) => { release = resolve; }));
    const provider = new LrclibLyricsProvider(fetcher as typeof fetch);
    const first = new AbortController();
    const a = expect(provider.find(track, first.signal)).rejects.toMatchObject({ name: 'AbortError' });
    const b = provider.find(track);
    first.abort();
    release(Response.json(candidate()));
    await a;
    expect((await b)?.providerItemId).toBe('1');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('records decisions without metadata or lyric contents', async () => {
    const telemetry = new ThirdPartyTelemetry();
    const record = vi.spyOn(telemetry, 'record');
    const provider = new LrclibLyricsProvider(vi.fn(async () => Response.json(candidate())) as typeof fetch, telemetry);
    await provider.find(track);
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ operation: 'match:exact:accepted' }));
    expect(JSON.stringify(record.mock.calls)).not.toContain('Una línea');
    expect(JSON.stringify(record.mock.calls)).not.toContain(track.artist);
  });
});

describe('parseLrc', () => {
  it('supports several timestamps on the same line', () => {
    expect(parseLrc('[00:01.0][00:02.00]Eco')).toEqual([
      { startMs: 1_000, text: 'Eco' }, { startMs: 2_000, text: 'Eco' },
    ]);
  });

  it('applies a positive global offset by showing lyrics sooner', () => {
    expect(parseLrc('[offset:+250]\n[00:01.00]Antes\n[00:00.10]Inicio')).toEqual([
      { startMs: 0, text: 'Inicio' },
      { startMs: 750, text: 'Antes' },
    ]);
  });
});
