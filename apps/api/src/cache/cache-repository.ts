import type { Database } from '../db/database.js';

export interface CachedObjectEntry {
  relativePath: string;
  contentHash: string;
  contentType: string;
  byteLength: number;
  fetchedAt?: Date;
  nextRefreshAt?: Date | null;
  revision?: string;
  imageLastResult?: 'image' | 'placeholder' | 'error' | null;
  imageAttempts?: number;
  previousImage?: ImageVersion | null;
  previousImageExpiresAt?: Date | null;
  rejectedImageHash?: string | null;
  rejectedImageUntil?: Date | null;
}

export type ImageVersion = Pick<CachedObjectEntry,
  'relativePath' | 'contentHash' | 'contentType' | 'byteLength'> & { fetchedAt?: string };

export interface CacheEvictionCandidate extends CachedObjectEntry {
  namespace: 'image' | 'lyrics' | 'provider' | 'analysis';
  key: string;
}

export class CacheRepository {
  public constructor(private readonly db: Database) {}

  /** Publishers share a lock; GC/eviction is exclusive, including filesystem IO. */
  public async withObjectMutation<T>(operation: (repository: CacheRepository) => Promise<T>): Promise<T> {
    return this.withObjectLock(false, operation);
  }

  public async withMaintenance<T>(operation: (repository: CacheRepository) => Promise<T>): Promise<T> {
    return this.withObjectLock(true, operation);
  }

  private async withObjectLock<T>(exclusive: boolean, operation: (repository: CacheRepository) => Promise<T>): Promise<T> {
    if (!this.db.transaction) throw new Error('Cache object lifecycle requires database transactions');
    return this.db.transaction(async (db) => {
      await db.query('SET LOCAL lock_timeout = \'5s\'');
      await db.query(`SELECT ${exclusive ? 'pg_advisory_xact_lock' : 'pg_advisory_xact_lock_shared'}(hashtextextended('hirmos:cache-object-lifecycle', 0))`);
      return operation(new CacheRepository({ query: db.query, close: async () => undefined }));
    });
  }

  public async referencedHashes(): Promise<Set<string>> {
    const result = await this.db.query<{ object_hash: string }>(`SELECT object_hash FROM cache_entries UNION SELECT previous_image->>'contentHash' FROM cache_entries WHERE previous_image IS NOT NULL AND previous_image_expires_at > now()`);
    return new Set(result.rows.map(row => row.object_hash));
  }

  /** Call under withMaintenance; rechecks current references before touching the file. */
  public async orphanEligible(hash: string, graceMs: number): Promise<boolean> {
    const present = await this.db.query<{ present: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM cache_entries WHERE object_hash = $1 OR (previous_image IS NOT NULL AND previous_image_expires_at > now() AND previous_image->>'contentHash' = $1)) AS present`, [hash]);
    if (present.rows[0]?.present) {
      await this.forgetOrphan(hash);
      return false;
    }
    await this.db.query('INSERT INTO cache_object_gc (object_hash) VALUES ($1) ON CONFLICT DO NOTHING', [hash]);
    const result = await this.db.query<{ eligible: boolean }>(
      `SELECT first_unreferenced_at <= now() - ($2::double precision * interval '1 millisecond') AS eligible
         FROM cache_object_gc WHERE object_hash = $1`, [hash, graceMs]);
    return result.rows[0]?.eligible === true;
  }

  public async forgetOrphan(hash: string): Promise<void> {
    await this.db.query('DELETE FROM cache_object_gc WHERE object_hash = $1', [hash]);
  }

  public async get(namespace: 'image' | 'lyrics' | 'provider' | 'analysis', key: string) {
    const result = await this.db.query<{
      relative_path: string; content_hash: string; content_type: string; byte_length: string;
      fetched_at: Date; next_refresh_at: Date | null; revision: string;
      image_last_result: CachedObjectEntry['imageLastResult']; image_attempts: number;
      previous_image: ImageVersion | null; previous_image_expires_at: Date | null;
      rejected_image_hash: string | null; rejected_image_until: Date | null;
    }>(
      `SELECT relative_path, content_hash, content_type, byte_length, fetched_at,
              next_refresh_at, revision::text, image_last_result, image_attempts,
              previous_image, previous_image_expires_at, rejected_image_hash, rejected_image_until
         FROM cache_entries
        WHERE namespace = $1 AND cache_key = $2`,
      [namespace, key],
    );
    const row = result.rows[0];
    return row ? {
      relativePath: row.relative_path,
      contentHash: row.content_hash,
      contentType: row.content_type,
      byteLength: Number(row.byte_length),
      fetchedAt: row.fetched_at,
      nextRefreshAt: row.next_refresh_at,
      revision: row.revision,
      imageLastResult: row.image_last_result,
      imageAttempts: row.image_attempts,
      previousImage: row.previous_image,
      previousImageExpiresAt: row.previous_image_expires_at,
      rejectedImageHash: row.rejected_image_hash,
      rejectedImageUntil: row.rejected_image_until,
    } satisfies CachedObjectEntry : null;
  }

  /** Network IO happens outside this transaction. Fence late publishers,
   * including concurrent cold inserts, while sharing the existing GC lock. */
  public async publishImage<T>(key: string, expectedRevision: string | null,
    operation: (repository: CacheRepository) => Promise<T>): Promise<{ published: boolean; value?: T }> {
    return this.withObjectMutation(async repository => {
      await repository.db.query("SELECT pg_advisory_xact_lock(hashtextextended('hirmos:image:' || $1, 0))", [key]);
      const current = await repository.get('image', key);
      if ((current?.revision ?? null) !== expectedRevision) return { published: false };
      return { published: true, value: await operation(repository) };
    });
  }

  public async recordImageAttempt(key: string, result: 'image' | 'placeholder' | 'error',
    attempts: number, delayMs: number): Promise<void> {
    await this.db.query(`UPDATE cache_entries SET image_last_result = $2,
        image_attempts = $3, image_checked_at = now(),
        next_refresh_at = now() + ($4::double precision * interval '1 millisecond'),
        revision = revision + 1
      WHERE namespace = 'image' AND cache_key = $1`, [key, result, attempts, delayMs]);
  }

  /** Called inside publishImage, with a verified, distinct previous image. */
  public async retainPreviousImage(key: string, previous: CachedObjectEntry): Promise<void> {
    const version: ImageVersion = { relativePath: previous.relativePath, contentHash: previous.contentHash,
      contentType: previous.contentType, byteLength: previous.byteLength, fetchedAt: previous.fetchedAt?.toISOString() };
    await this.db.query(`UPDATE cache_entries SET previous_image = $2::jsonb,
      previous_image_expires_at = now() + interval '30 days'
      WHERE namespace = 'image' AND cache_key = $1`, [key, JSON.stringify(version)]);
    await this.forgetOrphan(previous.contentHash);
  }

  /** Caller validates the previous file outside the transaction, then fences
   * this mutation with publishImage. Recovery does not turn old data into fresh. */
  public async restorePreviousImage(key: string, previous: ImageVersion, rejectHash?: string): Promise<void> {
    await this.db.query(`UPDATE cache_entries SET object_hash=$2, content_hash=$2,
      relative_path=$3, content_type=$4, byte_length=$5, fetched_at=COALESCE($6::timestamptz, fetched_at),
      previous_image=NULL, previous_image_expires_at=NULL, revision=revision+1,
      image_last_result='image', image_attempts=0, next_refresh_at=now()+interval '30 seconds',
      rejected_image_hash=COALESCE($7, rejected_image_hash),
      rejected_image_until=CASE WHEN $7::text IS NOT NULL THEN now()+interval '30 days' ELSE rejected_image_until END
      WHERE namespace='image' AND cache_key=$1`,
      [key, previous.contentHash, previous.relativePath, previous.contentType, previous.byteLength, previous.fetchedAt ?? null, rejectHash ?? null]);
    await this.forgetOrphan(previous.contentHash);
  }

  public async put(input: {
    namespace: 'image' | 'lyrics' | 'provider' | 'analysis';
    key: string;
    sourceId?: string;
    entityType?: 'artist' | 'album' | 'track';
    remoteEntityId?: string;
    variant: string;
    objectHash: string;
    relativePath: string;
    contentType: string;
    byteLength: number;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO cache_entries
         (namespace, cache_key, source_id, entity_type, remote_entity_id, variant,
          object_hash, relative_path, content_type, byte_length, content_hash,
          access_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $7, 1)
       ON CONFLICT (namespace, cache_key) DO UPDATE SET
         source_id = EXCLUDED.source_id,
         entity_type = EXCLUDED.entity_type,
         remote_entity_id = EXCLUDED.remote_entity_id,
         variant = EXCLUDED.variant,
         object_hash = EXCLUDED.object_hash,
         relative_path = EXCLUDED.relative_path,
         content_type = EXCLUDED.content_type,
         byte_length = EXCLUDED.byte_length,
         content_hash = EXCLUDED.content_hash,
         revision = cache_entries.revision + 1,
         fetched_at = now(), validated_at = now(), last_accessed_at = now(),
         access_count = cache_entries.access_count + 1`,
      [input.namespace, input.key, input.sourceId ?? null, input.entityType ?? null,
       input.remoteEntityId ?? null, input.variant, input.objectHash, input.relativePath,
       input.contentType, input.byteLength],
    );
    await this.forgetOrphan(input.objectHash);
  }

  public async touch(namespace: 'image' | 'lyrics' | 'provider' | 'analysis', key: string) {
    await this.db.query(
      `UPDATE cache_entries
          SET last_accessed_at = now(), access_count = access_count + 1
        WHERE namespace = $1 AND cache_key = $2`,
      [namespace, key],
    );
  }

  /** Indexed unique bytes only; maintenance uses ObjectStore.inventory for disk quota. */
  public async physicalByteLength(): Promise<number> {
    const result = await this.db.query<{ bytes: string }>(
      `SELECT COALESCE(sum(byte_length), 0)::text AS bytes
         FROM (
           SELECT object_hash, max(byte_length) AS byte_length
             FROM (
               SELECT object_hash, byte_length FROM cache_entries
               UNION ALL SELECT previous_image->>'contentHash', (previous_image->>'byteLength')::bigint
                 FROM cache_entries WHERE previous_image IS NOT NULL AND previous_image_expires_at > now()
             ) referenced GROUP BY object_hash
         ) objects`,
    );
    return Number(result.rows[0]?.bytes ?? 0);
  }

  public async evictionCandidates(limit: number): Promise<CacheEvictionCandidate[]> {
    const result = await this.db.query<{
      namespace: CacheEvictionCandidate['namespace']; cache_key: string;
      relative_path: string; content_hash: string; content_type: string; byte_length: string;
    }>(
      `SELECT namespace, cache_key, relative_path, content_hash, content_type, byte_length
         FROM cache_entries entry
        WHERE namespace IN ('image', 'provider', 'analysis')
          AND (protected_until IS NULL OR protected_until < now())
          AND (previous_image_expires_at IS NULL OR previous_image_expires_at <= now())
          AND (
            namespace <> 'image'
            OR CASE WHEN variant ~ '^[0-9]+$' THEN variant::integer ELSE 320 END > 128
            OR NOT EXISTS (
              SELECT 1 FROM catalog_artists artist
               WHERE artist.source_id = entry.source_id
                 AND artist.cover_art_id = entry.remote_entity_id
                 AND artist.missing_since IS NULL
              UNION ALL
              SELECT 1 FROM catalog_albums album
               WHERE album.source_id = entry.source_id
                 AND album.cover_art_id = entry.remote_entity_id
                 AND album.missing_since IS NULL
              UNION ALL
              SELECT 1 FROM catalog_tracks track
               WHERE track.source_id = entry.source_id
                 AND track.cover_art_id = entry.remote_entity_id
                 AND track.missing_since IS NULL
            )
          )
        ORDER BY
          CASE WHEN namespace = 'analysis' THEN 0 WHEN namespace = 'provider' THEN 1 ELSE 2 END,
          last_accessed_at ASC, access_count ASC, byte_length DESC
        LIMIT $1`,
      [limit],
    );
    return result.rows.map((row) => ({
      namespace: row.namespace,
      key: row.cache_key,
      relativePath: row.relative_path,
      contentHash: row.content_hash,
      contentType: row.content_type,
      byteLength: Number(row.byte_length),
    }));
  }

  public async removeEntry(namespace: CacheEvictionCandidate['namespace'], key: string, expectedHash: string): Promise<boolean> {
    const removed = await this.db.query<{ object_hash: string }>(
      `DELETE FROM cache_entries entry WHERE namespace = $1 AND cache_key = $2 AND object_hash = $3
         AND namespace <> 'lyrics' AND (protected_until IS NULL OR protected_until < now())
          AND (previous_image_expires_at IS NULL OR previous_image_expires_at <= now())
         AND (namespace <> 'image'
           OR CASE WHEN variant ~ '^[0-9]+$' THEN variant::integer ELSE 320 END > 128
           OR NOT EXISTS (
             SELECT 1 FROM catalog_artists a WHERE a.source_id=entry.source_id
               AND a.cover_art_id=entry.remote_entity_id AND a.missing_since IS NULL
             UNION ALL
             SELECT 1 FROM catalog_albums a WHERE a.source_id=entry.source_id
               AND a.cover_art_id=entry.remote_entity_id AND a.missing_since IS NULL
             UNION ALL
             SELECT 1 FROM catalog_tracks t WHERE t.source_id=entry.source_id
               AND t.cover_art_id=entry.remote_entity_id AND t.missing_since IS NULL))
       RETURNING object_hash`,
      [namespace, key, expectedHash],
    );
    const hash = removed.rows[0]?.object_hash;
    if (!hash) return false;
    const remaining = await this.db.query<{ present: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM cache_entries WHERE object_hash = $1 OR (previous_image IS NOT NULL AND previous_image_expires_at > now() AND previous_image->>'contentHash' = $1)) AS present`,
      [hash],
    );
    return !remaining.rows[0]?.present;
  }
}
