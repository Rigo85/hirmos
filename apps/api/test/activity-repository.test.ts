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

  it('loads time-bounded habit evidence from daily aggregates and maps database values', async () => {
    const query = vi.fn(async () => result([{
      source_id: 'source-a', remote_track_id: 'track-a', title: 'Song',
      artist_name: 'Artist', remote_artist_id: 'artist-a', album_name: 'Album',
      remote_album_id: 'album-a', duration_ms: 180_000, cover_art_id: null,
      artist_cover_art_id: null, release_year: 2026, canonical_artist_id: null,
      canonical_artist_name: null, play_starts: 3, qualified_plays: 2,
      imported_plays: 0,
      completions: 2, skips: 1, listened_ms: '321000',
      first_played_at: new Date('2026-09-01T00:00:00Z'),
      last_played_at: new Date('2026-09-02T00:00:00Z'), estimated: false,
    }]));
    const repository = new ActivityRepository({ query } as unknown as Database);

    const evidence = await repository.habitEvidence('user-a', '2026-08-06');

    expect(query).toHaveBeenCalledWith(expect.stringContaining('user_track_daily_stats'), ['user-a', '2026-08-06']);
    expect(evidence[0]).toMatchObject({ listenedMs: 321000, qualifiedPlays: 2, artist: 'Artist' });
  });
});

function result(rows: unknown[]) {
  return { rows, rowCount: rows.length, command: '', oid: 0, fields: [] };
}
