import type { Database } from '../db/database.js';

export interface MetadataWarmJob {
  id: number;
  sourceId: string;
  remoteArtistId: string;
  attempts: number;
}

export interface MetadataWarmQueueStats {
  pending: number;
  running: number;
  completed: number;
  failed: number;
}

export class MetadataWarmRepository {
  public constructor(private readonly db: Database) {}

  public async enqueueStaleArtists(): Promise<number> {
    const result = await this.db.query<{ id: string }>(
      `WITH candidates AS (
         SELECT artist.source_id, artist.remote_artist_id
           FROM catalog_artists artist
           JOIN music_sources source ON source.id = artist.source_id AND source.enabled
          WHERE artist.missing_since IS NULL
            AND (
              artist.detail_fetched_at IS NULL
              OR artist.detail_fetched_at < now() - interval '30 days'
              OR NOT EXISTS (
                SELECT 1 FROM metadata_provider_cache cache
                 WHERE cache.source_id = artist.source_id
                   AND cache.entity_type = 'artist'
                   AND cache.remote_entity_id = artist.remote_artist_id
                   AND cache.provider = 'musicbrainz'
              )
              OR EXISTS (
                SELECT 1 FROM metadata_provider_cache cache
                 WHERE cache.source_id = artist.source_id
                   AND cache.entity_type = 'artist'
                   AND cache.remote_entity_id = artist.remote_artist_id
                   AND cache.next_refresh_at <= now()
              )
            )
       )
       INSERT INTO background_jobs (kind, dedupe_key, payload, priority)
       SELECT 'metadata_refresh', source_id::text || ':artist:' || remote_artist_id,
              jsonb_build_object(
                'sourceId', source_id::text,
                'entityType', 'artist',
                'remoteId', remote_artist_id
              ), 5
         FROM candidates
       ON CONFLICT (kind, dedupe_key) DO UPDATE SET
         status = 'pending', available_at = now(), lease_owner = NULL,
         lease_expires_at = NULL, last_error_code = NULL, updated_at = now()
       WHERE background_jobs.status = 'completed'
       RETURNING id`,
    );
    await this.completeInactiveArtists();
    return result.rowCount ?? 0;
  }

  public async claim(workerId: string, leaseMs = 60_000): Promise<MetadataWarmJob | null> {
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
            AND artist.remote_artist_id = job.payload->>'remoteId'
            AND artist.missing_since IS NULL
          WHERE job.kind = 'metadata_refresh'
            AND job.payload->>'entityType' = 'artist'
            AND (
              (job.status IN ('pending', 'failed') AND job.available_at <= now())
              OR (job.status = 'running' AND job.lease_expires_at < now())
            )
          ORDER BY job.priority DESC, job.available_at, job.id
          FOR UPDATE OF job SKIP LOCKED
          LIMIT 1
       )
       UPDATE background_jobs job
          SET status = 'running', attempts = attempts + 1,
              lease_owner = $1,
              lease_expires_at = now() + ($2::integer * interval '1 millisecond'),
              updated_at = now()
         FROM candidate
        WHERE job.id = candidate.id
       RETURNING job.id, job.payload->>'sourceId' AS source_id,
                 job.payload->>'remoteId' AS remote_id, job.attempts`,
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
      `UPDATE background_jobs
          SET status = 'completed', lease_owner = NULL, lease_expires_at = NULL,
              last_error_code = NULL, updated_at = now()
        WHERE id = $1 AND kind = 'metadata_refresh' AND lease_owner = $2`,
      [id, workerId],
    );
  }

  public async fail(
    id: number,
    workerId: string,
    errorCode: string,
    retryDelayMs: number,
  ): Promise<void> {
    await this.db.query(
      `UPDATE background_jobs
          SET status = 'failed', available_at = now() + ($3::integer * interval '1 millisecond'),
              lease_owner = NULL, lease_expires_at = NULL,
              last_error_code = $4, updated_at = now()
        WHERE id = $1 AND kind = 'metadata_refresh' AND lease_owner = $2`,
      [id, workerId, retryDelayMs, errorCode],
    );
  }

  public async stats(): Promise<MetadataWarmQueueStats> {
    const result = await this.db.query<{
      pending: string; running: string; completed: string; failed: string;
    }>(
      `SELECT count(*) FILTER (WHERE status = 'pending')::text AS pending,
              count(*) FILTER (WHERE status = 'running')::text AS running,
              count(*) FILTER (WHERE status = 'completed')::text AS completed,
              count(*) FILTER (WHERE status = 'failed')::text AS failed
         FROM background_jobs WHERE kind = 'metadata_refresh'`,
    );
    const row = result.rows[0];
    return {
      pending: Number(row?.pending ?? 0), running: Number(row?.running ?? 0),
      completed: Number(row?.completed ?? 0), failed: Number(row?.failed ?? 0),
    };
  }

  private async completeInactiveArtists(): Promise<void> {
    await this.db.query(
      `UPDATE background_jobs job
          SET status = 'completed', lease_owner = NULL, lease_expires_at = NULL,
              last_error_code = NULL, updated_at = now()
        WHERE job.kind = 'metadata_refresh'
          AND job.status IN ('pending', 'failed')
          AND job.payload->>'entityType' = 'artist'
          AND NOT EXISTS (
            SELECT 1 FROM catalog_artists artist
             WHERE artist.source_id = (job.payload->>'sourceId')::uuid
               AND artist.remote_artist_id = job.payload->>'remoteId'
               AND artist.missing_since IS NULL
          )`,
    );
  }
}
