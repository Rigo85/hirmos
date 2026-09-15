import type { Database } from '../db/database.js';

export type TopSongsOutcome = 'nonempty' | 'empty' | 'temporary_error' | 'not_found' | 'suspect';

export interface TopSongsJob {
  id: number;
  sourceId: string;
  remoteArtistId: string;
  attempts: number;
}

export interface TopSongsQueueStats {
  pending: number;
  running: number;
  completed: number;
  failed: number;
  artists: number;
  useful: number;
  empty: number;
  stale: number;
}

export interface TopSongsRefreshControl {
  enqueueAll(sourceId: string): Promise<number>;
  stats(sourceId?: string): Promise<TopSongsQueueStats>;
}

export interface TopSongsBaseline {
  itemCount: number;
  lastCheckOutcome: TopSongsOutcome | null;
  candidateHash: string | null;
  consecutiveWeakObservations: number;
}

const POSITIVE_REFRESH_DAYS = 7;
const EMPTY_REFRESH_HOURS = 24;
const SUSPECT_REFRESH_HOURS = 1;

export class TopSongsRepository {
  public constructor(private readonly db: Database) {}

  public async currentTrackIds(sourceId: string, remoteArtistId: string): Promise<string[] | null> {
    const result = await this.db.query<{ exists: boolean; ids: string[] }>(
      `SELECT true AS exists,
              COALESCE(array_agg(item.remote_track_id ORDER BY item.rank)
                FILTER (WHERE track.remote_track_id IS NOT NULL), ARRAY[]::text[]) AS ids
         FROM artist_top_songs_state state
         LEFT JOIN artist_top_songs_items item
           ON item.source_id = state.source_id
          AND item.remote_artist_id = state.remote_artist_id
         LEFT JOIN catalog_tracks track
           ON track.source_id = item.source_id
          AND track.remote_track_id = item.remote_track_id
          AND track.missing_since IS NULL
        WHERE state.source_id = $1 AND state.remote_artist_id = $2
        GROUP BY state.source_id, state.remote_artist_id`,
      [sourceId, remoteArtistId],
    );
    return result.rows[0]?.ids ?? null;
  }

  public async artistName(sourceId: string, remoteArtistId: string): Promise<string | null> {
    const result = await this.db.query<{ name: string }>(
      `SELECT name FROM catalog_artists
        WHERE source_id = $1 AND remote_artist_id = $2 AND missing_since IS NULL`,
      [sourceId, remoteArtistId],
    );
    return result.rows[0]?.name ?? null;
  }

  public async baseline(sourceId: string, remoteArtistId: string): Promise<TopSongsBaseline> {
    const result = await this.db.query<{
      item_count: string; last_check_outcome: TopSongsOutcome | null;
      candidate_hash: string | null; consecutive_weak_observations: number;
    }>(
      `SELECT count(item.remote_track_id)::text AS item_count,
              state.last_check_outcome, state.candidate_hash,
              state.consecutive_weak_observations
         FROM artist_top_songs_state state
         LEFT JOIN artist_top_songs_items item
           ON item.source_id = state.source_id
          AND item.remote_artist_id = state.remote_artist_id
        WHERE state.source_id = $1 AND state.remote_artist_id = $2
        GROUP BY state.last_check_outcome, state.candidate_hash,
                 state.consecutive_weak_observations`,
      [sourceId, remoteArtistId],
    );
    const row = result.rows[0];
    return {
      itemCount: Number(row?.item_count ?? 0),
      lastCheckOutcome: row?.last_check_outcome ?? null,
      candidateHash: row?.candidate_hash ?? null,
      consecutiveWeakObservations: row?.consecutive_weak_observations ?? 0,
    };
  }

  public async recordNonempty(
    sourceId: string,
    remoteArtistId: string,
    remoteTrackIds: string[],
    contentHash: string,
  ): Promise<void> {
    const transaction = this.db.transaction
      ? this.db.transaction.bind(this.db)
      : async <T>(operation: (database: Pick<Database, 'query'>) => Promise<T>) => operation(this.db);
    await transaction(async (database) => {
      await database.query(
        `INSERT INTO artist_top_songs_state (
           source_id, remote_artist_id, last_check_outcome, last_checked_at,
           last_nonempty_at, validated_at, next_refresh_at, content_hash,
           candidate_hash, consecutive_weak_observations,
           source_metadata_generation
         )
         SELECT $1, $2, 'nonempty', now(), now(), now(),
                now() + ($4::integer * interval '1 day'), $3, NULL, 0,
                source.metadata_generation
           FROM music_sources source WHERE source.id = $1
         ON CONFLICT (source_id, remote_artist_id) DO UPDATE SET
           last_check_outcome = 'nonempty', last_checked_at = now(),
           last_nonempty_at = now(), validated_at = now(),
           next_refresh_at = now() + ($4::integer * interval '1 day'),
           content_hash = $3, candidate_hash = NULL,
           consecutive_weak_observations = 0,
           source_metadata_generation = EXCLUDED.source_metadata_generation
         `,
        [sourceId, remoteArtistId, contentHash, POSITIVE_REFRESH_DAYS],
      );
      await database.query(
        `DELETE FROM artist_top_songs_items
          WHERE source_id = $1 AND remote_artist_id = $2`,
        [sourceId, remoteArtistId],
      );
      await database.query(
        `INSERT INTO artist_top_songs_items (
         source_id, remote_artist_id, remote_track_id, rank
       )
       SELECT $1, $2, requested.remote_track_id, requested.rank::integer
         FROM unnest($3::text[]) WITH ORDINALITY AS requested(remote_track_id, rank)
         JOIN catalog_tracks track
           ON track.source_id = $1
          AND track.remote_track_id = requested.remote_track_id
          AND track.missing_since IS NULL
        WHERE requested.rank <= 50
       ON CONFLICT DO NOTHING`,
        [sourceId, remoteArtistId, remoteTrackIds],
      );
    });
  }

  public async recordWeakObservation(
    sourceId: string,
    remoteArtistId: string,
    outcome: Extract<TopSongsOutcome, 'empty' | 'suspect'>,
    candidateHash: string | null,
  ): Promise<void> {
    const hours = outcome === 'empty' ? EMPTY_REFRESH_HOURS : SUSPECT_REFRESH_HOURS;
    await this.db.query(
      `INSERT INTO artist_top_songs_state (
         source_id, remote_artist_id, last_check_outcome, last_checked_at,
         next_refresh_at, candidate_hash, consecutive_weak_observations,
         source_metadata_generation
       )
       SELECT $1, $2, $3, now(), now() + ($5::integer * interval '1 hour'),
              $4, 1, source.metadata_generation
         FROM music_sources source WHERE source.id = $1
       ON CONFLICT (source_id, remote_artist_id) DO UPDATE SET
         last_check_outcome = EXCLUDED.last_check_outcome,
         last_checked_at = now(), next_refresh_at = EXCLUDED.next_refresh_at,
         candidate_hash = EXCLUDED.candidate_hash,
         consecutive_weak_observations = CASE
           WHEN artist_top_songs_state.last_check_outcome = EXCLUDED.last_check_outcome
            AND artist_top_songs_state.candidate_hash IS NOT DISTINCT FROM EXCLUDED.candidate_hash
           THEN artist_top_songs_state.consecutive_weak_observations + 1 ELSE 1 END,
         source_metadata_generation = EXCLUDED.source_metadata_generation`,
      [sourceId, remoteArtistId, outcome, candidateHash, hours],
    );
  }

  public async recordTemporaryError(sourceId: string, remoteArtistId: string): Promise<void> {
    await this.db.query(
      `INSERT INTO artist_top_songs_state (
         source_id, remote_artist_id, last_check_outcome, last_checked_at, next_refresh_at
       ) VALUES ($1, $2, 'temporary_error', now(), now() + interval '1 hour')
       ON CONFLICT (source_id, remote_artist_id) DO UPDATE SET
         last_check_outcome = 'temporary_error', last_checked_at = now(),
         next_refresh_at = LEAST(
           artist_top_songs_state.next_refresh_at, now() + interval '1 hour'
         )`,
      [sourceId, remoteArtistId],
    );
  }

  public async enqueueDue(): Promise<number> {
    await this.ensureStates();
    return this.enqueueWhere(
      `state.next_refresh_at <= now()
       OR state.source_metadata_generation < source.metadata_generation`,
      [],
      20,
    );
  }

  public async enqueueAffected(sourceId: string, remoteArtistIds: string[]): Promise<number> {
    if (!remoteArtistIds.length) return 0;
    await this.ensureStates(sourceId, remoteArtistIds);
    await this.db.query(
      `UPDATE artist_top_songs_state
          SET next_refresh_at = now(), catalog_generation = catalog_generation + 1
        WHERE source_id = $1 AND remote_artist_id = ANY($2::text[])`,
      [sourceId, remoteArtistIds],
    );
    return this.enqueueWhere(
      `state.source_id = $1 AND state.remote_artist_id = ANY($2::text[])`,
      [sourceId, remoteArtistIds],
      40,
      true,
    );
  }

  public async enqueueAll(sourceId: string): Promise<number> {
    await this.db.query(
      `UPDATE music_sources SET metadata_generation = metadata_generation + 1
        WHERE id = $1 AND enabled`,
      [sourceId],
    );
    await this.ensureStates(sourceId);
    return this.enqueueWhere(`state.source_id = $1`, [sourceId], 50, true);
  }

  public async claim(workerId: string, leaseMs = 60_000): Promise<TopSongsJob | null> {
    const result = await this.db.query<{
      id: string; source_id: string; remote_id: string; attempts: number;
    }>(
      `WITH candidate AS (
         SELECT job.id
           FROM background_jobs job
           JOIN music_sources source
             ON source.id = (job.payload->>'sourceId')::uuid AND source.enabled
           JOIN catalog_artists artist
             ON artist.source_id = source.id
            AND artist.remote_artist_id = job.payload->>'remoteArtistId'
            AND artist.missing_since IS NULL
          WHERE job.kind = 'top_songs_refresh'
            AND ((job.status IN ('pending', 'failed') AND job.available_at <= now())
              OR (job.status = 'running' AND job.lease_expires_at < now()))
          ORDER BY job.priority DESC, job.available_at, job.id
          FOR UPDATE OF job SKIP LOCKED LIMIT 1
       )
       UPDATE background_jobs job
          SET status = 'running', attempts = attempts + 1, lease_owner = $1,
              lease_expires_at = now() + ($2::integer * interval '1 millisecond'),
              updated_at = now()
         FROM candidate WHERE job.id = candidate.id
       RETURNING job.id, job.payload->>'sourceId' AS source_id,
                 job.payload->>'remoteArtistId' AS remote_id, job.attempts`,
      [workerId, leaseMs],
    );
    const row = result.rows[0];
    return row ? {
      id: Number(row.id), sourceId: row.source_id,
      remoteArtistId: row.remote_id, attempts: row.attempts,
    } : null;
  }

  public async complete(id: number, workerId: string): Promise<void> {
    await this.db.query(
      `UPDATE background_jobs SET status = 'completed', lease_owner = NULL,
              lease_expires_at = NULL, last_error_code = NULL, updated_at = now()
        WHERE id = $1 AND kind = 'top_songs_refresh' AND lease_owner = $2`,
      [id, workerId],
    );
  }

  public async fail(
    id: number, workerId: string, errorCode: string, retryDelayMs: number,
  ): Promise<void> {
    await this.db.query(
      `UPDATE background_jobs SET status = 'failed',
              available_at = now() + ($3::integer * interval '1 millisecond'),
              lease_owner = NULL, lease_expires_at = NULL,
              last_error_code = $4, updated_at = now()
        WHERE id = $1 AND kind = 'top_songs_refresh' AND lease_owner = $2`,
      [id, workerId, retryDelayMs, errorCode],
    );
  }

  public async stats(sourceId?: string): Promise<TopSongsQueueStats> {
    const result = await this.db.query<{
      pending: string; running: string; completed: string; failed: string;
      artists: string; useful: string; empty: string; stale: string;
    }>(
      `SELECT
         (SELECT count(*) FROM background_jobs job
           WHERE kind = 'top_songs_refresh'
             AND ($1::uuid IS NULL OR (job.payload->>'sourceId')::uuid = $1)
             AND status = 'pending')::text AS pending,
         (SELECT count(*) FROM background_jobs job
           WHERE kind = 'top_songs_refresh'
             AND ($1::uuid IS NULL OR (job.payload->>'sourceId')::uuid = $1)
             AND status = 'running')::text AS running,
         (SELECT count(*) FROM background_jobs job
           WHERE kind = 'top_songs_refresh'
             AND ($1::uuid IS NULL OR (job.payload->>'sourceId')::uuid = $1)
             AND status = 'completed')::text AS completed,
         (SELECT count(*) FROM background_jobs job
           WHERE kind = 'top_songs_refresh'
             AND ($1::uuid IS NULL OR (job.payload->>'sourceId')::uuid = $1)
             AND status = 'failed')::text AS failed,
         count(*)::text AS artists,
         count(*) FILTER (WHERE EXISTS (
           SELECT 1 FROM artist_top_songs_items item
            WHERE item.source_id = state.source_id
              AND item.remote_artist_id = state.remote_artist_id
         ))::text AS useful,
         count(*) FILTER (WHERE state.last_check_outcome = 'empty')::text AS empty,
         count(*) FILTER (WHERE state.next_refresh_at <= now())::text AS stale
       FROM artist_top_songs_state state
       WHERE ($1::uuid IS NULL OR state.source_id = $1)`,
      [sourceId ?? null],
    );
    const row = result.rows[0];
    return {
      pending: Number(row?.pending ?? 0), running: Number(row?.running ?? 0),
      completed: Number(row?.completed ?? 0), failed: Number(row?.failed ?? 0),
      artists: Number(row?.artists ?? 0), useful: Number(row?.useful ?? 0),
      empty: Number(row?.empty ?? 0), stale: Number(row?.stale ?? 0),
    };
  }

  private async ensureStates(sourceId?: string, remoteArtistIds?: string[]): Promise<void> {
    await this.db.query(
      `INSERT INTO artist_top_songs_state (source_id, remote_artist_id, next_refresh_at)
       SELECT artist.source_id, artist.remote_artist_id, now()
         FROM catalog_artists artist
         JOIN music_sources source ON source.id = artist.source_id AND source.enabled
        WHERE artist.missing_since IS NULL
          AND ($1::uuid IS NULL OR artist.source_id = $1)
          AND ($2::text[] IS NULL OR artist.remote_artist_id = ANY($2))
       ON CONFLICT DO NOTHING`,
      [sourceId ?? null, remoteArtistIds ?? null],
    );
  }

  private async enqueueWhere(
    condition: string, values: readonly unknown[], priority: number, reviveFailed = false,
  ): Promise<number> {
    const priorityIndex = values.length + 1;
    const result = await this.db.query<{ id: string }>(
      `INSERT INTO background_jobs (kind, dedupe_key, payload, priority)
       SELECT 'top_songs_refresh',
              state.source_id::text || ':artist:' || state.remote_artist_id,
              jsonb_build_object('sourceId', state.source_id::text,
                                 'remoteArtistId', state.remote_artist_id),
              $${priorityIndex}::integer
         FROM artist_top_songs_state state
         JOIN music_sources source ON source.id = state.source_id AND source.enabled
         JOIN catalog_artists artist
           ON artist.source_id = state.source_id
          AND artist.remote_artist_id = state.remote_artist_id
          AND artist.missing_since IS NULL
        WHERE ${condition}
       ON CONFLICT (kind, dedupe_key) DO UPDATE SET
         status = 'pending', available_at = now(),
         priority = GREATEST(background_jobs.priority, EXCLUDED.priority),
         lease_owner = NULL, lease_expires_at = NULL,
         last_error_code = NULL, updated_at = now()
       WHERE background_jobs.status = 'completed'
          ${reviveFailed ? "OR background_jobs.status = 'failed'" : ''}
       RETURNING id`,
      [...values, priority],
    );
    return result.rowCount ?? 0;
  }
}
