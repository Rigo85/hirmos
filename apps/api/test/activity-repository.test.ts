import { describe, expect, it, vi } from 'vitest';
import type { Database } from '../src/db/database.js';
import { ActivityRepository } from '../src/activity/activity-repository.js';

describe('ActivityRepository lists', () => {
  it('pages recent tracks within the authenticated user', async () => {
    const query = vi.fn(async () => result([{ source_id: 'source-a', remote_track_id: 'track-a' }]));
    const repository = new ActivityRepository({ query } as unknown as Database);

    const references = await repository.recentTrackReferences('user-a', 21, 40);

    expect(references).toHaveLength(1);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('LIMIT $2 OFFSET $3'), ['user-a', 21, 40]);
  });

  it('orders and pages most-played tracks using personal listening evidence', async () => {
    const query = vi.fn(async () => result([]));
    const repository = new ActivityRepository({ query } as unknown as Database);

    await repository.mostPlayedTrackReferences('user-a', 31, 30);

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('ORDER BY listened_ms DESC, completions DESC, play_starts DESC'),
      ['user-a', 31, 30],
    );
  });
});

function result(rows: unknown[]) {
  return { rows, rowCount: rows.length, command: '', oid: 0, fields: [] };
}
