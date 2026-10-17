import { describe, expect, it, vi } from 'vitest';
import type { LyricsProvider } from '../src/lyrics/lyrics-provider.js';
import type { LyricsRepository } from '../src/lyrics/lyrics-repository.js';
import type { MusicSourceAdapter, SourceTrack } from '../src/music-source/music-source-adapter.js';
import type { MusicSourceAdapterFactory } from '../src/music-source/music-source-adapter-factory.js';
import type { MusicSourceRepository, StoredMusicSource } from '../src/music-source/music-source-repository.js';
import { MusicSourceService } from '../src/music-source/music-source-service.js';
import type { SourceCredentialCipher } from '../src/music-source/source-credential-cipher.js';
import { encodeTrackReference } from '../src/music-source/track-reference.js';

describe('MusicSourceService lyrics', () => {
  it('downloads OpenSubsonic lyrics once and reuses the durable cached document', async () => {
    const document = {
      displayArtist: 'Artist', displayTitle: 'Song', language: null, synced: false,
      lines: [{ startMs: null, text: 'A permanent line' }],
    };
    const track: SourceTrack = {
      id: 'track-a', title: 'Song', artist: 'Artist', artistId: null,
      album: 'Album', albumId: null, durationMs: 180_000, coverArtId: null,
      year: 2026, favorite: false,
    };
    let cached: typeof document[] | undefined;
    const adapter = {
      getTrack: vi.fn(async () => track),
      getLyrics: vi.fn(async () => [document]),
    } as unknown as MusicSourceAdapter;
    const repository = {
      getAdjustment: vi.fn(async () => 0),
      get: vi.fn(async (input: { provider: string }) =>
        input.provider === 'opensubsonic' ? cached : undefined),
      put: vi.fn(async (input: { provider: string; document: typeof document | null }) => {
        if (input.provider === 'opensubsonic' && input.document) cached = [input.document];
      }),
    } as unknown as LyricsRepository;
    const rawCache = {
      put: vi.fn(async () => ({ key: 'raw-key', parserVersion: 'normalized-v1' })),
    };
    const service = new MusicSourceService(
      { current: vi.fn(async () => source()) } as unknown as MusicSourceRepository,
      { decrypt: vi.fn(() => ({ username: 'service', password: 'secret' })) } as unknown as SourceCredentialCipher,
      { create: vi.fn(() => adapter) } as unknown as MusicSourceAdapterFactory,
      undefined,
      repository,
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      rawCache as never,
    );

    const reference = encodeTrackReference('source-a', 'track-a');
    await service.lyrics(reference, 'user-a');
    await service.lyrics(reference, 'user-a');

    expect(adapter.getLyrics).toHaveBeenCalledTimes(1);
    expect(rawCache.put).toHaveBeenCalledTimes(1);
    expect(repository.put).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'opensubsonic', rawObjectKey: 'raw-key', parserVersion: 'normalized-v1',
    }));
  });

  it('continues through the public-provider chain and caches each result independently', async () => {
    const calls: string[] = [];
    const track: SourceTrack = {
      id: 'track-a', title: 'Song', artist: 'Artist', artistId: null,
      album: 'Album', albumId: null, durationMs: 180_000, coverArtId: null,
      year: 2026, favorite: false,
    };
    const first: LyricsProvider = {
      name: 'amll-ttml',
      find: vi.fn(async () => { calls.push('amll-ttml'); return null; }),
    };
    const second: LyricsProvider = {
      name: 'lrclib',
      find: vi.fn(async () => {
        calls.push('lrclib');
        return {
          providerItemId: '7', instrumental: false,
          document: {
            displayArtist: 'Artist', displayTitle: 'Song', language: 'en', synced: true,
            lines: [{ startMs: 1_000, text: 'Line' }],
          },
        };
      }),
    };
    const adapter = {
      getTrack: vi.fn(async () => track),
      getLyrics: vi.fn(async () => []),
    } as unknown as MusicSourceAdapter;
    const put = vi.fn(async () => undefined);
    const lyricsRepository = {
      getAdjustment: vi.fn(async () => 125),
      get: vi.fn(async () => undefined),
      put,
    } as unknown as LyricsRepository;
    const service = new MusicSourceService(
      { current: vi.fn(async () => source()) } as unknown as MusicSourceRepository,
      { decrypt: vi.fn(() => ({ username: 'service', password: 'secret' })) } as unknown as SourceCredentialCipher,
      { create: vi.fn(() => adapter) } as unknown as MusicSourceAdapterFactory,
      undefined,
      lyricsRepository,
      [first, second],
    );

    const result = await service.lyrics(encodeTrackReference('source-a', 'track-a'), 'user-a');

    expect(calls).toEqual(['amll-ttml', 'lrclib']);
    expect(put.mock.calls.map(([value]) => ({
      provider: value.provider,
      found: value.document !== null,
    }))).toEqual([
      { provider: 'amll-ttml', found: false },
      { provider: 'lrclib', found: true },
    ]);
    expect(result).toMatchObject({
      adjustmentMs: 125,
      availability: 'available',
      lyrics: [{ lines: [{ startMs: 1_000, text: 'Line' }] }],
    });
    expect(adapter.getLyrics).not.toHaveBeenCalled();
  });

  it('does not convert a provider failure into a normal miss', async () => {
    const provider: LyricsProvider = {
      name: 'lrclib',
      find: vi.fn(async () => { throw new TypeError('temporary network failure'); }),
    };
    const adapter = {
      getTrack: vi.fn(async () => ({
        id: 'track-a', title: 'Song', artist: 'Artist', artistId: null,
        album: 'Album', albumId: null, durationMs: 180_000, coverArtId: null,
        year: null, genres: [], musicBrainzId: null, favorite: false,
      })),
      getLyrics: vi.fn(async () => []),
    } as unknown as MusicSourceAdapter;
    const put = vi.fn(async () => undefined);
    const repository = {
      getAdjustment: vi.fn(async () => 0),
      get: vi.fn(async () => undefined),
      getStaleFound: vi.fn(async () => undefined),
      put,
    } as unknown as LyricsRepository;
    const service = new MusicSourceService(
      { current: vi.fn(async () => source()) } as unknown as MusicSourceRepository,
      { decrypt: vi.fn(() => ({ username: 'service', password: 'secret' })) } as unknown as SourceCredentialCipher,
      { create: vi.fn(() => adapter) } as unknown as MusicSourceAdapterFactory,
      undefined,
      repository,
      [provider],
    );

    await expect(service.lyrics(
      encodeTrackReference('source-a', 'track-a'), 'user-a',
    )).resolves.toMatchObject({ lyrics: [], availability: 'temporarily_unavailable' });
    expect(put).not.toHaveBeenCalled();
  });

  it('passes the lookup version only to negative-cache checks and writes', async () => {
    const { service, repository } = lookupFixture({ name: 'lrclib', negativeCacheVersion: 'lrclib-lookup-v2',
      find: vi.fn(async () => null) });
    await service.lyrics(encodeTrackReference('source-a', 'track-a'), 'user-a');
    expect(repository.get).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'lrclib', negativeCacheVersion: 'lrclib-lookup-v2',
    }));
    expect(repository.put).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'lrclib', parserVersion: 'lrclib-lookup-v2', document: null,
    }));
  });

  it('keeps a positive cache without fetching even after lookup strategy changes', async () => {
    const provider = { name: 'lrclib', negativeCacheVersion: 'v2', find: vi.fn() };
    const { service, repository } = lookupFixture(provider);
    vi.mocked(repository.get).mockResolvedValue([fallbackDocument]);
    await service.lyrics(encodeTrackReference('source-a', 'track-a'), 'user-a');
    expect(provider.find).not.toHaveBeenCalled();
    expect(repository.put).not.toHaveBeenCalled();
  });

  it('falls back on ambiguous lyrics without persisting a public-provider miss', async () => {
    const { service, repository, adapter } = lookupFixture({ name: 'lrclib',
      find: vi.fn(async () => { throw new Error('LRCLIB could not establish a reliable match'); }) });
    vi.mocked(adapter.getLyrics).mockResolvedValue([fallbackDocument]);
    await expect(service.lyrics(encodeTrackReference('source-a', 'track-a'), 'user-a'))
      .resolves.toMatchObject({ availability: 'available', lyrics: [fallbackDocument] });
    expect(repository.put).toHaveBeenCalledTimes(1);
    expect(repository.put).toHaveBeenCalledWith(expect.objectContaining({ provider: 'opensubsonic' }));
  });

  it('does not launch another provider or write negative cache on caller cancellation', async () => {
    const controller = new AbortController();
    const { service, repository, adapter } = lookupFixture({ name: 'lrclib',
      find: vi.fn(async () => { controller.abort(); controller.signal.throwIfAborted(); return null; }) });
    await expect(service.lyrics(encodeTrackReference('source-a', 'track-a'), 'user-a', controller.signal))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(adapter.getLyrics).not.toHaveBeenCalled();
    expect(repository.put).not.toHaveBeenCalled();
  });
});

const fallbackDocument = { displayArtist: 'Artist', displayTitle: 'Song', language: null, synced: false,
  lines: [{ startMs: null, text: 'Synthetic fallback' }] };

function lookupFixture(provider: LyricsProvider) {
  const adapter = { getTrack: vi.fn(async () => ({ id: 'track-a', title: 'Song', artist: 'Artist',
    album: 'Album', durationMs: 180_000 })), getLyrics: vi.fn(async () => []) } as unknown as MusicSourceAdapter;
  const repository = { getAdjustment: vi.fn(async () => 0), get: vi.fn(async () => undefined),
    getStaleFound: vi.fn(async () => undefined), put: vi.fn(async () => undefined) } as unknown as LyricsRepository;
  const service = new MusicSourceService(
    { current: vi.fn(async () => source()) } as unknown as MusicSourceRepository,
    { decrypt: vi.fn(() => ({ username: 'service', password: 'secret' })) } as unknown as SourceCredentialCipher,
    { create: vi.fn(() => adapter) } as unknown as MusicSourceAdapterFactory, undefined, repository, [provider]);
  return { service, repository, adapter };
}

function source(): StoredMusicSource {
  return {
    id: 'source-a', name: 'Library', baseUrl: 'http://example.test', adapterType: 'navidrome',
    credentialCiphertext: Buffer.from('cipher'), encryptionKeyVersion: 1, enabled: true,
    healthy: true, capabilities: [], serverVersion: '1', lastCheckedAt: null, lastSyncedAt: null,
  };
}
