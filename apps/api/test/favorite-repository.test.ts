import { describe, expect, it, vi } from 'vitest';
import type { Database } from '../src/db/database.js';
import { FavoriteRepository, trackKey } from '../src/favorites/favorite-repository.js';
import { decodeTrackReference } from '../src/music-source/track-reference.js';

describe('FavoriteRepository', () => {
  it('lists only the authenticated user track favorites in stable newest-first order', async () => {
    const query = vi.fn(async () => ({ rows: [
      { source_id: '11111111-1111-4111-8111-111111111111', remote_entity_id: 'track-a' },
    ] }));
    const repository = new FavoriteRepository({ query } as unknown as Database);

    const references = await repository.trackReferences('user-a', 51, 0);

    expect(decodeTrackReference(references[0]!)).toEqual({
      sourceId: '11111111-1111-4111-8111-111111111111', remoteId: 'track-a',
    });
    expect(query.mock.calls[0]![1]).toEqual(['user-a', 51, 0]);
    expect(query.mock.calls[0]![0]).toContain("entity_type = 'track'");
  });

  it('matches candidates and makes add/remove idempotent', async () => {
    const sourceId = '11111111-1111-4111-8111-111111111111';
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ source_id: sourceId, remote_entity_id: 'track-a' }] })
      .mockResolvedValue({ rows: [] });
    const repository = new FavoriteRepository({ query } as unknown as Database);

    expect(await repository.matchingTrackKeys('user-a', [
      { sourceId, remoteTrackId: 'track-a' },
    ])).toEqual(new Set([trackKey(sourceId, 'track-a')]));
    await repository.setTrack('user-a', sourceId, 'track-a', true);
    await repository.setTrack('user-a', sourceId, 'track-a', false);

    expect(query.mock.calls[1]![0]).toContain('ON CONFLICT');
    expect(query.mock.calls[2]![0]).toContain('DELETE FROM user_favorites');
  });
});
