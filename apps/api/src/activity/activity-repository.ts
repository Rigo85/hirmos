import type { PlaybackSnapshot } from '@hirmos/contracts';
import type { Database } from '../db/database.js';
import { decodeTrackReference, encodeTrackReference } from '../music-source/track-reference.js';

export type ListenEventType =
  | 'started' | 'resumed' | 'paused' | 'progressed' | 'seeked' | 'skipped' | 'completed';

export interface HabitEvidence {
  sourceId: string;
  remoteTrackId: string;
  title: string;
  artist: string;
  remoteArtistId: string | null;
  album: string;
  remoteAlbumId: string | null;
  durationMs: number;
  coverArtId: string | null;
  artistCoverArtId: string | null;
  year: number | null;
  canonicalArtistId: string | null;
  canonicalArtistName: string | null;
  playStarts: number;
  qualifiedPlays: number;
  importedPlays: number;
  completions: number;
  skips: number;
  listenedMs: number;
  firstPlayedAt: string | null;
  lastPlayedAt: string | null;
  estimated: boolean;
}

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

  public async recentTrackReferences(
    userId: string,
    limit: number,
    offset = 0,
  ): Promise<string[]> {
    const result = await this.db.query<{ source_id: string; remote_track_id: string }>(
      `SELECT source_id, remote_track_id
         FROM user_track_stats
        WHERE user_id = $1 AND last_played_at IS NOT NULL
        ORDER BY last_played_at DESC
        LIMIT $2 OFFSET $3`,
      [userId, limit, offset],
    );
    return result.rows.map((row) => encodeTrackReference(row.source_id, row.remote_track_id));
  }

  public async mostPlayedTrackReferences(
    userId: string,
    limit: number,
    offset = 0,
  ): Promise<string[]> {
    const result = await this.db.query<{ source_id: string; remote_track_id: string }>(
      `SELECT source_id, remote_track_id
         FROM user_track_stats
        WHERE user_id = $1 AND (listened_ms > 0 OR play_starts > 0)
        ORDER BY listened_ms DESC, completions DESC, play_starts DESC, last_played_at DESC
        LIMIT $2 OFFSET $3`,
      [userId, limit, offset],
    );
    return result.rows.map((row) => encodeTrackReference(row.source_id, row.remote_track_id));
  }

  public async trackedReferences(userId: string): Promise<string[]> {
    const result = await this.db.query<{ source_id: string; remote_track_id: string }>(
      `SELECT source_id, remote_track_id
         FROM user_track_stats
        WHERE user_id = $1
        ORDER BY last_played_at DESC NULLS LAST`,
      [userId],
    );
    return result.rows.map((row) => encodeTrackReference(row.source_id, row.remote_track_id));
  }

  public async habitEvidence(userId: string, startDate: string | null): Promise<HabitEvidence[]> {
    const result = await this.db.query<{
      source_id: string;
      remote_track_id: string;
      title: string;
      artist_name: string;
      remote_artist_id: string | null;
      album_name: string;
      remote_album_id: string | null;
      duration_ms: number;
      cover_art_id: string | null;
      artist_cover_art_id: string | null;
      release_year: number | null;
      canonical_artist_id: string | null;
      canonical_artist_name: string | null;
      play_starts: number;
      qualified_plays: number;
      imported_plays: number;
      completions: number;
      skips: number;
      listened_ms: string;
      first_played_at: Date | null;
      last_played_at: Date | null;
      estimated: boolean;
    }>(
      `WITH evidence AS (
         SELECT source_id, remote_track_id, play_starts, qualified_plays, imported_plays,
                completions, skips, listened_ms, first_played_at, last_played_at,
                false AS estimated
           FROM user_track_stats
          WHERE user_id = $1 AND $2::date IS NULL
         UNION ALL
         SELECT source_id, remote_track_id, SUM(play_starts)::integer,
                SUM(qualified_plays)::integer, SUM(imported_plays)::integer,
                SUM(completions)::integer,
                SUM(skips)::integer, SUM(listened_ms)::bigint,
                MIN(first_played_at), MAX(last_played_at), BOOL_OR(estimated)
           FROM user_track_daily_stats
          WHERE user_id = $1 AND $2::date IS NOT NULL AND stat_date >= $2::date
          GROUP BY source_id, remote_track_id
       )
       SELECT evidence.source_id, evidence.remote_track_id, track.title,
              track.artist_name, track.remote_artist_id, track.album_name,
              track.remote_album_id, track.duration_ms, track.cover_art_id,
              artist.cover_art_id AS artist_cover_art_id, track.release_year,
              member.canonical_artist_id,
              canonical.display_name AS canonical_artist_name,
              evidence.play_starts, evidence.qualified_plays, evidence.imported_plays,
              evidence.completions,
              evidence.skips, evidence.listened_ms, evidence.first_played_at,
              evidence.last_played_at, evidence.estimated
         FROM evidence
         JOIN catalog_tracks track
           ON track.source_id = evidence.source_id
          AND track.remote_track_id = evidence.remote_track_id
         LEFT JOIN catalog_artists artist
           ON artist.source_id = track.source_id
          AND artist.remote_artist_id = track.remote_artist_id
         LEFT JOIN canonical_artist_members member
           ON member.source_id = track.source_id
          AND member.remote_artist_id = track.remote_artist_id
         LEFT JOIN canonical_artists canonical
           ON canonical.id = member.canonical_artist_id`,
      [userId, startDate],
    );
    return result.rows.map((row) => ({
      sourceId: row.source_id,
      remoteTrackId: row.remote_track_id,
      title: row.title,
      artist: row.artist_name,
      remoteArtistId: row.remote_artist_id,
      album: row.album_name,
      remoteAlbumId: row.remote_album_id,
      durationMs: row.duration_ms,
      coverArtId: row.cover_art_id,
      artistCoverArtId: row.artist_cover_art_id,
      year: row.release_year,
      canonicalArtistId: row.canonical_artist_id,
      canonicalArtistName: row.canonical_artist_name,
      playStarts: row.play_starts,
      qualifiedPlays: row.qualified_plays,
      importedPlays: row.imported_plays,
      completions: row.completions,
      skips: row.skips,
      listenedMs: Number(row.listened_ms),
      firstPlayedAt: row.first_played_at?.toISOString() ?? null,
      lastPlayedAt: row.last_played_at?.toISOString() ?? null,
      estimated: row.estimated,
    }));
  }

  public async habitsSince(userId: string): Promise<string | null> {
    const result = await this.db.query<{ since: Date | null }>(
      `SELECT MIN(first_played_at) AS since
         FROM user_track_stats
        WHERE user_id = $1`,
      [userId],
    );
    return result.rows[0]?.since?.toISOString() ?? null;
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
      `WITH lifetime AS (
       INSERT INTO user_track_stats
         (user_id, source_id, remote_track_id, play_starts, qualified_plays,
          completions, skips,
          listened_ms, first_played_at, last_played_at, last_position_ms, last_observed_at)
       VALUES ($1, $2, $3,
         CASE WHEN $4 = 'started' THEN 1 ELSE 0 END,
         CASE WHEN $4 = 'completed' THEN 1 ELSE 0 END,
         CASE WHEN $4 = 'completed' THEN 1 ELSE 0 END,
         CASE WHEN $4 = 'skipped' THEN 1 ELSE 0 END,
         $6,
         CASE WHEN $4 = 'started' THEN now() ELSE NULL END,
         CASE WHEN $4 IN ('started', 'resumed', 'completed') THEN now() ELSE NULL END,
         $5, now())
       ON CONFLICT (user_id, source_id, remote_track_id) DO UPDATE SET
         play_starts = user_track_stats.play_starts + EXCLUDED.play_starts,
         qualified_plays = user_track_stats.qualified_plays + EXCLUDED.qualified_plays,
         completions = user_track_stats.completions + EXCLUDED.completions,
         skips = user_track_stats.skips + EXCLUDED.skips,
         listened_ms = user_track_stats.listened_ms + EXCLUDED.listened_ms,
         first_played_at = COALESCE(user_track_stats.first_played_at, EXCLUDED.first_played_at),
         last_played_at = COALESCE(EXCLUDED.last_played_at, user_track_stats.last_played_at),
         last_position_ms = EXCLUDED.last_position_ms,
         last_observed_at = now()
       RETURNING 1
       )
       INSERT INTO user_track_daily_stats
         (user_id, source_id, remote_track_id, stat_date, play_starts,
          qualified_plays, completions, skips, listened_ms, first_played_at,
          last_played_at)
       VALUES ($1, $2, $3, (now() AT TIME ZONE 'UTC')::date,
         CASE WHEN $4 = 'started' THEN 1 ELSE 0 END,
         CASE WHEN $4 = 'completed' THEN 1 ELSE 0 END,
         CASE WHEN $4 = 'completed' THEN 1 ELSE 0 END,
         CASE WHEN $4 = 'skipped' THEN 1 ELSE 0 END,
         $6,
         CASE WHEN $4 = 'started' THEN now() ELSE NULL END,
         CASE WHEN $4 IN ('started', 'resumed', 'completed') THEN now() ELSE NULL END)
       ON CONFLICT (user_id, source_id, remote_track_id, stat_date) DO UPDATE SET
         play_starts = user_track_daily_stats.play_starts + EXCLUDED.play_starts,
         qualified_plays = user_track_daily_stats.qualified_plays + EXCLUDED.qualified_plays,
         completions = user_track_daily_stats.completions + EXCLUDED.completions,
         skips = user_track_daily_stats.skips + EXCLUDED.skips,
         listened_ms = user_track_daily_stats.listened_ms + EXCLUDED.listened_ms,
         first_played_at = COALESCE(user_track_daily_stats.first_played_at,
                                    EXCLUDED.first_played_at),
         last_played_at = COALESCE(EXCLUDED.last_played_at,
                                   user_track_daily_stats.last_played_at),
         estimated = user_track_daily_stats.estimated OR EXCLUDED.estimated`,
      [userId, sourceId, remoteTrackId, type, Math.max(0, positionMs), listenedMs],
    );
  }
}
