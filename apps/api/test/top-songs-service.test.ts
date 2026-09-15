import { describe, expect, it, vi } from 'vitest';
import { MusicSourceService } from '../src/music-source/music-source-service.js';
import type { MusicSourceAdapter } from '../src/music-source/music-source-adapter.js';

describe('artist top songs refresh', () => {
  it('records an empty observation without replacing the useful set', async () => {
    const topSongs = fakeTopSongs();
    const service = createService([], topSongs);

    await expect(service.refreshArtistTopSongs(SOURCE_ID, 'artist-1')).resolves.toBe('empty');

    expect(topSongs.recordWeakObservation).toHaveBeenCalledWith(
      SOURCE_ID, 'artist-1', 'empty', null,
    );
    expect(topSongs.recordNonempty).not.toHaveBeenCalled();
  });

  it('requires a suspicious contraction to repeat before replacing the useful set', async () => {
    const tracks = [sourceTrack('track-1'), sourceTrack('track-2')];
    const topSongs = fakeTopSongs();
    topSongs.baseline
      .mockResolvedValueOnce({
        itemCount: 50, lastCheckOutcome: 'nonempty',
        candidateHash: null, consecutiveWeakObservations: 0,
      })
      .mockResolvedValueOnce({
        itemCount: 50,
        lastCheckOutcome: 'suspect',
        candidateHash: '70f390c431341bd9f8daaa0d4a3ecaf95ac8619fed74d0bb9f3385f35b97ebfa',
        consecutiveWeakObservations: 1,
      });
    const service = createService(tracks, topSongs);

    await expect(service.refreshArtistTopSongs(SOURCE_ID, 'artist-1')).resolves.toBe('suspect');
    expect(topSongs.recordNonempty).not.toHaveBeenCalled();
    await expect(service.refreshArtistTopSongs(SOURCE_ID, 'artist-1')).resolves.toBe('nonempty');
    expect(topSongs.recordNonempty).toHaveBeenCalledWith(
      SOURCE_ID, 'artist-1', ['track-1', 'track-2'], expect.stringMatching(/^[0-9a-f]{64}$/),
    );
  });
});

const SOURCE_ID = '33333333-3333-4333-8333-333333333333';

function createService(tracks: ReturnType<typeof sourceTrack>[], topSongs: ReturnType<typeof fakeTopSongs>) {
  const source = {
    id: SOURCE_ID, name: 'Library', baseUrl: 'https://music.example.test',
    adapterType: 'navidrome' as const, credentialCiphertext: Buffer.from('cipher'),
    encryptionKeyVersion: 1, enabled: true, healthy: true, capabilities: [],
    serverVersion: '1', lastCheckedAt: null, lastSyncedAt: null,
  };
  const adapter = { getArtistTopTracks: vi.fn(async () => tracks) } as unknown as MusicSourceAdapter;
  return new MusicSourceService(
    { current: vi.fn(async () => source) } as never,
    { decrypt: vi.fn(() => ({ username: 'user', password: 'password' })) } as never,
    { create: vi.fn(() => adapter) },
    undefined, undefined, [], undefined, undefined, undefined, undefined, undefined,
    topSongs as never,
  );
}

function fakeTopSongs() {
  return {
    artistName: vi.fn(async () => 'Artist'),
    baseline: vi.fn(async () => ({
      itemCount: 20, lastCheckOutcome: 'nonempty',
      candidateHash: null, consecutiveWeakObservations: 0,
    })),
    recordWeakObservation: vi.fn(async () => undefined),
    recordNonempty: vi.fn(async () => undefined),
  };
}

function sourceTrack(id: string) {
  return {
    id, title: id, artist: 'Artist', artistId: 'artist-1', album: 'Album', albumId: 'album-1',
    durationMs: 1_000, coverArtId: null, year: null, genres: [], musicBrainzId: null,
    favorite: false,
  };
}
