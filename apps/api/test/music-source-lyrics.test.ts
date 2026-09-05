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
      lyrics: [{ lines: [{ startMs: 1_000, text: 'Line' }] }],
    });
    expect(adapter.getLyrics).not.toHaveBeenCalled();
  });
});

function source(): StoredMusicSource {
  return {
    id: 'source-a', name: 'Library', baseUrl: 'http://example.test', adapterType: 'navidrome',
    credentialCiphertext: Buffer.from('cipher'), encryptionKeyVersion: 1, enabled: true,
    healthy: true, capabilities: [], serverVersion: '1', lastCheckedAt: null, lastSyncedAt: null,
  };
}
