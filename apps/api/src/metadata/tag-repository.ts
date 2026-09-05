import type { Database } from '../db/database.js';
import type { TagEvidence } from './tag-provider.js';

interface EvidenceRow {
  provider: TagEvidence['provider'];
  raw_name: string;
  normalized_name: string;
  category: TagEvidence['category'];
  score: number;
}

export class TagRepository {
  public constructor(private readonly db: Database) {}

  public async aliases(): Promise<Map<string, string>> {
    const result = await this.db.query<{ alias_key: string; canonical_name: string }>(
      'SELECT alias_key, canonical_name FROM metadata_tag_aliases',
    );
    return new Map(result.rows.map((row) => [row.alias_key, row.canonical_name]));
  }

  public async cachedArtistEvidence(
    sourceId: string,
    remoteArtistId: string,
    provider: 'musicbrainz' | 'lastfm',
  ): Promise<TagEvidence[] | undefined> {
    const cached = await this.db.query<{ present: boolean }>(
      `SELECT true AS present
         FROM metadata_provider_cache
        WHERE source_id = $1 AND entity_type = 'artist' AND remote_entity_id = $2
          AND provider = $3 AND expires_at > now()`,
      [sourceId, remoteArtistId, provider],
    );
    if (!cached.rows[0]) return undefined;
    const result = await this.db.query<EvidenceRow>(
      `SELECT provider, raw_name, normalized_name, category, score
         FROM metadata_tag_evidence
        WHERE source_id = $1 AND entity_type = 'artist' AND remote_entity_id = $2
          AND provider = $3`,
      [sourceId, remoteArtistId, provider],
    );
    return result.rows.map(mapEvidence);
  }

  public async putArtistEvidence(
    sourceId: string,
    remoteArtistId: string,
    provider: TagEvidence['provider'],
    evidence: TagEvidence[],
    ttlHours: number,
  ): Promise<void> {
    await this.db.query(
      `DELETE FROM metadata_tag_evidence
        WHERE source_id = $1 AND entity_type = 'artist' AND remote_entity_id = $2
          AND provider = $3`,
      [sourceId, remoteArtistId, provider],
    );
    await this.db.query(
      `WITH inserted AS (
         INSERT INTO metadata_tag_evidence
           (source_id, entity_type, remote_entity_id, provider, raw_name,
            normalized_name, category, score)
         SELECT $1, 'artist', $2, $3, item.raw_name, item.normalized_name,
                item.category, item.score
           FROM jsonb_to_recordset($4::jsonb) AS item(
             raw_name text, normalized_name text, category text, score double precision
           )
       )
       INSERT INTO metadata_provider_cache
         (source_id, entity_type, remote_entity_id, provider, fetched_at, expires_at)
       VALUES ($1, 'artist', $2, $3, now(), now() + make_interval(hours => $5))
       ON CONFLICT (source_id, entity_type, remote_entity_id, provider) DO UPDATE SET
         fetched_at = now(), expires_at = EXCLUDED.expires_at`,
      [sourceId, remoteArtistId, provider, JSON.stringify(evidence.map((item) => ({
        raw_name: item.rawName,
        normalized_name: item.normalizedName,
        category: item.category,
        score: item.score,
      }))), ttlHours],
    );
  }

  public async saveResolvedArtistTags(
    sourceId: string,
    remoteArtistId: string,
    tags: Array<{ name: string; slug: string; score: number; evidence: TagEvidence[] }>,
  ): Promise<void> {
    await this.db.query(
      `DELETE FROM resolved_entity_tags
        WHERE source_id = $1 AND entity_type = 'artist' AND remote_entity_id = $2`,
      [sourceId, remoteArtistId],
    );
    await this.db.query(
      `INSERT INTO resolved_entity_tags
         (source_id, entity_type, remote_entity_id, tag_name, tag_slug, score, rank, evidence)
       SELECT $1, 'artist', $2, item.tag_name, item.tag_slug, item.score,
              item.rank, item.evidence
         FROM jsonb_to_recordset($3::jsonb) AS item(
           tag_name text, tag_slug text, score double precision, rank integer, evidence jsonb
         )`,
      [sourceId, remoteArtistId, JSON.stringify(tags.map((tag, index) => ({
        tag_name: tag.name, tag_slug: tag.slug, score: tag.score,
        rank: index + 1, evidence: tag.evidence,
      })))],
    );
  }
}

function mapEvidence(row: EvidenceRow): TagEvidence {
  return {
    provider: row.provider,
    rawName: row.raw_name,
    normalizedName: row.normalized_name,
    category: row.category,
    score: row.score,
  };
}
