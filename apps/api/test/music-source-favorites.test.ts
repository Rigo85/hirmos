import { describe, expect, it, vi } from 'vitest';
import type { FavoriteRepository } from '../src/favorites/favorite-repository.js';
import { trackKey } from '../src/favorites/favorite-repository.js';
import type { MusicSourceAdapter, SourceTrack } from '../src/music-source/music-source-adapter.js';
import type { MusicSourceAdapterFactory } from '../src/music-source/music-source-adapter-factory.js';
import type { MusicSourceRepository, StoredMusicSource } from '../src/music-source/music-source-repository.js';
import { MusicSourceService } from '../src/music-source/music-source-service.js';
import type { SourceCredentialCipher } from '../src/music-source/source-credential-cipher.js';
import { encodeTrackReference } from '../src/music-source/track-reference.js';

describe('MusicSourceService favorites', () => {
  it('overrides the service account star with the authenticated user favorite', async () => {
    const adapter = { search: vi.fn(async () => ({
      artists: [], albums: [], tracks: [track()], nextCursor: null,
    })) } as unknown as MusicSourceAdapter;
    const favorites = {
      matchingTrackKeys: vi.fn(async () => new Set([trackKey(sourceId, 'track-a')])),
    } as unknown as FavoriteRepository;
    const service = createService(adapter, favorites);

    const result = await service.search('user-a', 'Song');

    expect(result.tracks[0]).toMatchObject({ favorite: true, title: 'Song' });
    expect(favorites.matchingTrackKeys).toHaveBeenCalledWith('user-a', [
      { sourceId, remoteTrackId: 'track-a' },
    ]);
  });

  it('validates a track against the active source and persists only for its owner', async () => {
    const adapter = { getTrack: vi.fn(async () => track()) } as unknown as MusicSourceAdapter;
    const setTrack = vi.fn(async () => undefined);
    const service = createService(adapter, { setTrack } as unknown as FavoriteRepository);
    const reference = encodeTrackReference(sourceId, 'track-a');

    expect(await service.setTrackFavorite('user-a', reference, true)).toEqual({
      reference, favorite: true,
    });
    expect(setTrack).toHaveBeenCalledWith('user-a', sourceId, 'track-a', true);
    expect(adapter.getTrack).toHaveBeenCalledWith('track-a', expect.any(AbortSignal));
  });
});

const sourceId = '11111111-1111-4111-8111-111111111111';

function createService(adapter: MusicSourceAdapter, favorites: FavoriteRepository) {
  return new MusicSourceService(
    { current: vi.fn(async () => source()) } as unknown as MusicSourceRepository,
    { decrypt: vi.fn(() => ({ username: 'service', password: 'secret' })) } as unknown as SourceCredentialCipher,
    { create: vi.fn(() => adapter) } as unknown as MusicSourceAdapterFactory,
    undefined, undefined, [], undefined, undefined, favorites,
  );
}

function source(): StoredMusicSource {
  return {
    id: sourceId, name: 'Library', baseUrl: 'http://example.test', adapterType: 'navidrome',
    credentialCiphertext: Buffer.from('cipher'), encryptionKeyVersion: 1, enabled: true,
    healthy: true, capabilities: [], serverVersion: '1', lastCheckedAt: null, lastSyncedAt: null,
  };
}

function track(): SourceTrack {
  return {
    id: 'track-a', title: 'Song', artist: 'Artist', artistId: null, album: 'Album',
    albumId: null, durationMs: 180_000, coverArtId: null, year: 2026, genres: [],
    favorite: false, musicBrainzId: null,
  };
}
