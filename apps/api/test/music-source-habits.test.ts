import { describe, expect, it, vi } from 'vitest';
import type { ActivityRepository, HabitEvidence } from '../src/activity/activity-repository.js';
import type { CatalogRepository } from '../src/activity/catalog-repository.js';
import type { MusicSourceAdapterFactory } from '../src/music-source/music-source-adapter-factory.js';
import type { MusicSourceRepository, StoredMusicSource } from '../src/music-source/music-source-repository.js';
import { MusicSourceService } from '../src/music-source/music-source-service.js';
import type { SourceCredentialCipher } from '../src/music-source/source-credential-cipher.js';

describe('MusicSourceService habits', () => {
  it('groups confirmed aliases and gives imported listens a neutral duration weight', async () => {
    const activity = {
      trackedReferences: vi.fn(async () => []),
      habitEvidence: vi.fn(async () => [
        evidence({ remoteTrackId: 'queen-a', artist: 'Queensryche', remoteArtistId: 'artist-a', canonicalArtistId: 'canonical-queen', canonicalArtistName: 'Queensrÿche', qualifiedPlays: 3, importedPlays: 3, listenedMs: 0 }),
        evidence({ remoteTrackId: 'queen-b', artist: 'Queensrÿche', remoteArtistId: 'artist-b', canonicalArtistId: 'canonical-queen', canonicalArtistName: 'Queensrÿche', qualifiedPlays: 2, importedPlays: 2, listenedMs: 0 }),
        evidence({ remoteTrackId: 'audio', artist: 'Audioslave', remoteArtistId: 'artist-c', qualifiedPlays: 8, listenedMs: 600_000 }),
      ]),
      habitsSince: vi.fn(async () => '2026-03-01T00:00:00.000Z'),
    };
    const catalog = {
      missingTrackIds: vi.fn(async () => []),
      observeTracks: vi.fn(async () => undefined),
      missingArtistIds: vi.fn(async () => []),
    };
    const service = new MusicSourceService(
      { current: vi.fn(async () => source()) } as unknown as MusicSourceRepository,
      { decrypt: vi.fn(() => ({ username: 'service', password: 'secret' })) } as unknown as SourceCredentialCipher,
      { create: vi.fn(() => ({})) } as unknown as MusicSourceAdapterFactory,
      activity as unknown as ActivityRepository,
      undefined,
      undefined,
      catalog as unknown as CatalogRepository,
    );

    const result = await service.habits('user-a', 'artists', '30d', 10);

    expect(result.artists.map((artist) => artist.name)).toEqual(['Queensrÿche', 'Audioslave']);
    expect(result.artists[0]).toMatchObject({ qualifiedPlays: 5, trackCount: 2 });
    expect(result.dataSince).toBe('2026-03-01T00:00:00.000Z');
  });
});

function source(): StoredMusicSource {
  return {
    id: 'source-a', name: 'Library', baseUrl: 'http://example.test', adapterType: 'navidrome',
    credentialCiphertext: Buffer.from('cipher'), encryptionKeyVersion: 1, enabled: true,
    healthy: true, capabilities: [], serverVersion: '1', lastCheckedAt: null, lastSyncedAt: null,
  };
}

function evidence(overrides: Partial<HabitEvidence>): HabitEvidence {
  return {
    sourceId: 'source-a', remoteTrackId: 'track', title: 'Song', artist: 'Artist',
    remoteArtistId: 'artist', album: 'Album', remoteAlbumId: 'album', durationMs: 180_000,
    coverArtId: null, artistCoverArtId: null, year: 2026, canonicalArtistId: null,
    canonicalArtistName: null, playStarts: 1, qualifiedPlays: 1, completions: 1,
    importedPlays: 0, skips: 0, listenedMs: 180_000, firstPlayedAt: '2026-09-01T00:00:00.000Z',
    lastPlayedAt: '2026-09-01T00:03:00.000Z', estimated: false, ...overrides,
  };
}
