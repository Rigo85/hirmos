import type { PlaybackSnapshot } from '@hirmos/contracts';
import type { Database } from '../db/database.js';
import { decodeTrackReference, encodeTrackReference } from '../music-source/track-reference.js';

export type ListenEventType =
  | 'started' | 'resumed' | 'paused' | 'progressed' | 'seeked' | 'skipped' | 'completed';

export class ActivityRepository {
  public constructor(private readonly db: Database) {}

  public async recordEvent(input: {
    userId: string;
    deviceId?: string | null;
    snapshot: PlaybackSnapshot;
    type: ListenEventType;
    listenedMs?: number;
  }): Promise<void> {
    const track = input.snapshot.currentTrackRef
      ? decodeTrackReference(input.snapshot.currentTrackRef)
      : null;
    if (!track) return;
    const listenedMs = Math.max(0, Math.round(input.listenedMs ?? 0));
    await this.db.query(
      `INSERT INTO listen_events
         (user_id, source_id, remote_track_id, queue_item_id, device_id,
          event_type, position_ms, listened_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [input.userId, track.sourceId, track.remoteId, input.snapshot.currentQueueItemId,
       input.deviceId ?? null, input.type, input.snapshot.positionMs, listenedMs],
    );
    await this.updateStats(input.userId, track.sourceId, track.remoteId, input.type,
      input.snapshot.positionMs, listenedMs);
  }

  public async recordProgress(input: {
    userId: string;
    before: PlaybackSnapshot;
    after: PlaybackSnapshot;
  }): Promise<void> {
    const before = input.before.currentTrackRef
      ? decodeTrackReference(input.before.currentTrackRef)
      : null;
    const after = input.after.currentTrackRef
      ? decodeTrackReference(input.after.currentTrackRef)
      : null;
    if (!before || !after || before.sourceId !== after.sourceId || before.remoteId !== after.remoteId) {
      return;
    }
    const wallMs = Math.max(0, Date.now() - Date.parse(input.before.positionObservedAt));
    const positionDelta = input.after.positionMs - input.before.positionMs;
    const listenedMs = input.before.status === 'playing'
      ? Math.max(0, Math.min(positionDelta, wallMs + 5_000, 60_000))
      : 0;
    await this.updateStats(input.userId, after.sourceId, after.remoteId, 'progressed',
      input.after.positionMs, listenedMs);
  }

  public async recentTrackReferences(userId: string, limit: number): Promise<string[]> {
    const result = await this.db.query<{ source_id: string; remote_track_id: string }>(
      `SELECT source_id, remote_track_id
         FROM user_track_stats
        WHERE user_id = $1 AND last_played_at IS NOT NULL
        ORDER BY last_played_at DESC
        LIMIT $2`,
      [userId, limit],
    );
    return result.rows.map((row) => encodeTrackReference(row.source_id, row.remote_track_id));
  }

  public async mostPlayedTrackReferences(userId: string, limit: number): Promise<string[]> {
    const result = await this.db.query<{ source_id: string; remote_track_id: string }>(
      `SELECT source_id, remote_track_id
         FROM user_track_stats
        WHERE user_id = $1 AND (listened_ms > 0 OR play_starts > 0)
        ORDER BY listened_ms DESC, completions DESC, play_starts DESC, last_played_at DESC
        LIMIT $2`,
      [userId, limit],
    );
    return result.rows.map((row) => encodeTrackReference(row.source_id, row.remote_track_id));
  }

  private async updateStats(
    userId: string,
    sourceId: string,
    remoteTrackId: string,
    type: ListenEventType,
    positionMs: number,
    listenedMs: number,
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO user_track_stats
         (user_id, source_id, remote_track_id, play_starts, completions, skips,
          listened_ms, first_played_at, last_played_at, last_position_ms, last_observed_at)
       VALUES ($1, $2, $3,
         CASE WHEN $4 = 'started' THEN 1 ELSE 0 END,
         CASE WHEN $4 = 'completed' THEN 1 ELSE 0 END,
         CASE WHEN $4 = 'skipped' THEN 1 ELSE 0 END,
         $6,
         CASE WHEN $4 = 'started' THEN now() ELSE NULL END,
         CASE WHEN $4 IN ('started', 'resumed', 'completed') THEN now() ELSE NULL END,
         $5, now())
       ON CONFLICT (user_id, source_id, remote_track_id) DO UPDATE SET
         play_starts = user_track_stats.play_starts + EXCLUDED.play_starts,
         completions = user_track_stats.completions + EXCLUDED.completions,
         skips = user_track_stats.skips + EXCLUDED.skips,
         listened_ms = user_track_stats.listened_ms + EXCLUDED.listened_ms,
         first_played_at = COALESCE(user_track_stats.first_played_at, EXCLUDED.first_played_at),
         last_played_at = COALESCE(EXCLUDED.last_played_at, user_track_stats.last_played_at),
         last_position_ms = EXCLUDED.last_position_ms,
         last_observed_at = now()`,
      [userId, sourceId, remoteTrackId, type, Math.max(0, positionMs), listenedMs],
    );
  }
}
