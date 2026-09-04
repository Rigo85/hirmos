import { describe, expect, it, vi } from 'vitest';
import type { Database } from '../src/db/database.js';
import { LyricsRepository } from '../src/lyrics/lyrics-repository.js';

describe('LyricsRepository adjustments', () => {
  it('returns zero when a user has no saved adjustment', async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    const repository = new LyricsRepository({ query } as unknown as Database);

    await expect(repository.getAdjustment('user', 'source', 'track')).resolves.toBe(0);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('user_lyrics_adjustments'), [
      'user', 'source', 'track',
    ]);
  });

  it('upserts an adjustment scoped to user, source and track', async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 1 }));
    const repository = new LyricsRepository({ query } as unknown as Database);

    await repository.putAdjustment({
      userId: 'user', sourceId: 'source', remoteTrackId: 'track', adjustmentMs: 300,
    });

    expect(query).toHaveBeenCalledWith(expect.stringContaining('ON CONFLICT'), [
      'user', 'source', 'track', 300,
    ]);
  });
});
