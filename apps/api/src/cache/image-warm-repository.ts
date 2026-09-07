import type { Database } from '../db/database.js';

export interface ImageWarmJob {
  id: number;
  sourceId: string;
  remoteId: string;
  size: number;
  attempts: number;
}

export interface ImageWarmQueueStats {
  pending: number;
  running: number;
  completed: number;
  failed: number;
}

export class ImageWarmRepository {
  public constructor(private readonly db: Database) {}

  public async enqueueCatalogImages(size = 320): Promise<number> {
    const result = await this.db.query<{ id: string }>(
      `WITH candidate_rows AS (
         SELECT source_id, cover_art_id AS remote_id, 30 AS priority
           FROM catalog_albums
          WHERE missing_since IS NULL AND cover_art_id IS NOT NULL
         UNION ALL
         SELECT source_id, cover_art_id, 20
           FROM catalog_artists
          WHERE missing_since IS NULL AND cover_art_id IS NOT NULL
         UNION ALL
         SELECT source_id, cover_art_id, 10
           FROM catalog_tracks
          WHERE missing_since IS NULL AND cover_art_id IS NOT NULL
       ), candidates AS (
         SELECT item.source_id, item.remote_id, max(item.priority) AS priority
           FROM candidate_rows item
           JOIN music_sources source ON source.id = item.source_id AND source.enabled
          WHERE NOT EXISTS (
            SELECT 1 FROM cache_entries entry
             WHERE entry.namespace = 'image'
               AND entry.source_id = item.source_id
               AND entry.remote_entity_id = item.remote_id
               AND entry.variant = $1::text
               AND entry.fetched_at >= now() - interval '30 days'
          )
          GROUP BY item.source_id, item.remote_id
       )
       INSERT INTO background_jobs (kind, dedupe_key, payload, priority)
       SELECT 'image_warm', source_id::text || ':' || remote_id || ':' || $1::text,
              jsonb_build_object(
                'sourceId', source_id::text, 'remoteId', remote_id, 'size', $1::integer
              ), priority
         FROM candidates
       ON CONFLICT (kind, dedupe_key) DO UPDATE SET
         status = 'pending', available_at = now(), lease_owner = NULL,
         lease_expires_at = NULL, last_error_code = NULL, updated_at = now()
       WHERE background_jobs.status = 'completed'
       RETURNING id`,
      [size],
    );
    await this.completeAlreadyCached(size);
    await this.completeNoLongerReferenced(size);
    return result.rowCount ?? 0;
  }

  public async claim(workerId: string, leaseMs = 60_000): Promise<ImageWarmJob | null> {
    const result = await this.db.query<{
      id: string; source_id: string; remote_id: string; size: string; attempts: number;
    }>(
      `WITH candidate AS (
         SELECT job.id
           FROM background_jobs job
          WHERE job.kind = 'image_warm'
            AND EXISTS (
              SELECT 1 FROM catalog_albums album
               WHERE album.source_id = (job.payload->>'sourceId')::uuid
                 AND album.cover_art_id = job.payload->>'remoteId'
                 AND album.missing_since IS NULL
              UNION ALL
              SELECT 1 FROM catalog_artists artist
               WHERE artist.source_id = (job.payload->>'sourceId')::uuid
                 AND artist.cover_art_id = job.payload->>'remoteId'
                 AND artist.missing_since IS NULL
              UNION ALL
              SELECT 1 FROM catalog_tracks track
               WHERE track.source_id = (job.payload->>'sourceId')::uuid
                 AND track.cover_art_id = job.payload->>'remoteId'
                 AND track.missing_since IS NULL
            )
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
                 job.payload->>'remoteId' AS remote_id,
                 job.payload->>'size' AS size, job.attempts`,
      [workerId, leaseMs],
    );
    const row = result.rows[0];
    return row ? {
      id: Number(row.id),
      sourceId: row.source_id,
      remoteId: row.remote_id,
      size: Number(row.size),
      attempts: row.attempts,
    } : null;
  }

  public async complete(id: number, workerId: string): Promise<void> {
    await this.db.query(
      `UPDATE background_jobs
          SET status = 'completed', lease_owner = NULL, lease_expires_at = NULL,
              last_error_code = NULL, updated_at = now()
        WHERE id = $1 AND kind = 'image_warm' AND lease_owner = $2`,
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
        WHERE id = $1 AND kind = 'image_warm' AND lease_owner = $2`,
      [id, workerId, retryDelayMs, errorCode],
    );
  }

  public async stats(): Promise<ImageWarmQueueStats> {
    const result = await this.db.query<{
      pending: string; running: string; completed: string; failed: string;
    }>(
      `SELECT count(*) FILTER (WHERE status = 'pending')::text AS pending,
              count(*) FILTER (WHERE status = 'running')::text AS running,
              count(*) FILTER (WHERE status = 'completed')::text AS completed,
              count(*) FILTER (WHERE status = 'failed')::text AS failed
         FROM background_jobs WHERE kind = 'image_warm'`,
    );
    const row = result.rows[0];
    return {
      pending: Number(row?.pending ?? 0),
      running: Number(row?.running ?? 0),
      completed: Number(row?.completed ?? 0),
      failed: Number(row?.failed ?? 0),
    };
  }

  private async completeAlreadyCached(size: number): Promise<void> {
    await this.db.query(
      `UPDATE background_jobs job
          SET status = 'completed', lease_owner = NULL, lease_expires_at = NULL,
              last_error_code = NULL, updated_at = now()
        WHERE job.kind = 'image_warm'
          AND job.status <> 'completed'
          AND job.payload->>'size' = $1::text
          AND EXISTS (
            SELECT 1 FROM cache_entries entry
             WHERE entry.namespace = 'image'
               AND entry.source_id = (job.payload->>'sourceId')::uuid
               AND entry.remote_entity_id = job.payload->>'remoteId'
               AND entry.variant = job.payload->>'size'
               AND entry.fetched_at >= now() - interval '30 days'
          )`,
      [size],
    );
  }

  private async completeNoLongerReferenced(size: number): Promise<void> {
    await this.db.query(
      `UPDATE background_jobs job
          SET status = 'completed', lease_owner = NULL, lease_expires_at = NULL,
              last_error_code = NULL, updated_at = now()
        WHERE job.kind = 'image_warm'
          AND job.status IN ('pending', 'failed')
          AND job.payload->>'size' = $1::text
          AND NOT EXISTS (
            SELECT 1 FROM catalog_albums album
             WHERE album.source_id = (job.payload->>'sourceId')::uuid
               AND album.cover_art_id = job.payload->>'remoteId'
               AND album.missing_since IS NULL
            UNION ALL
            SELECT 1 FROM catalog_artists artist
             WHERE artist.source_id = (job.payload->>'sourceId')::uuid
               AND artist.cover_art_id = job.payload->>'remoteId'
               AND artist.missing_since IS NULL
            UNION ALL
            SELECT 1 FROM catalog_tracks track
             WHERE track.source_id = (job.payload->>'sourceId')::uuid
               AND track.cover_art_id = job.payload->>'remoteId'
               AND track.missing_since IS NULL
          )`,
      [size],
    );
  }
}
