import type { Database } from '../db/database.js';
import { encodeTrackReference } from '../music-source/track-reference.js';

export interface FavoriteTrackIdentity {
  sourceId: string;
  remoteTrackId: string;
}

export class FavoriteRepository {
  public constructor(private readonly db: Database) {}

  public async trackReferences(
    userId: string,
    limit: number,
    offset: number,
  ): Promise<string[]> {
    const result = await this.db.query<{ source_id: string; remote_entity_id: string }>(
      `SELECT source_id, remote_entity_id
         FROM user_favorites
        WHERE user_id = $1 AND entity_type = 'track'
        ORDER BY created_at DESC, source_id, remote_entity_id
        LIMIT $2 OFFSET $3`,
      [userId, limit, offset],
    );
    return result.rows.map((row) => encodeTrackReference(row.source_id, row.remote_entity_id));
  }

  public async matchingTrackKeys(
    userId: string,
    tracks: FavoriteTrackIdentity[],
  ): Promise<Set<string>> {
    if (!tracks.length) return new Set();
    const result = await this.db.query<{ source_id: string; remote_entity_id: string }>(
      `SELECT favorite.source_id, favorite.remote_entity_id
         FROM user_favorites favorite
         JOIN jsonb_to_recordset($2::jsonb) AS candidate(
           source_id uuid, remote_track_id text
         ) ON candidate.source_id = favorite.source_id
           AND candidate.remote_track_id = favorite.remote_entity_id
        WHERE favorite.user_id = $1 AND favorite.entity_type = 'track'`,
      [userId, JSON.stringify(tracks.map((track) => ({
        source_id: track.sourceId,
        remote_track_id: track.remoteTrackId,
      })))],
    );
    return new Set(result.rows.map((row) => trackKey(row.source_id, row.remote_entity_id)));
  }

  public async setTrack(
    userId: string,
    sourceId: string,
    remoteTrackId: string,
    favorite: boolean,
  ): Promise<void> {
    if (favorite) {
      await this.db.query(
        `INSERT INTO user_favorites
           (user_id, source_id, entity_type, remote_entity_id)
         VALUES ($1, $2, 'track', $3)
         ON CONFLICT (user_id, source_id, entity_type, remote_entity_id) DO NOTHING`,
        [userId, sourceId, remoteTrackId],
      );
      return;
    }
    await this.db.query(
      `DELETE FROM user_favorites
        WHERE user_id = $1 AND source_id = $2
          AND entity_type = 'track' AND remote_entity_id = $3`,
      [userId, sourceId, remoteTrackId],
    );
  }
}

export function trackKey(sourceId: string, remoteTrackId: string): string {
  return `${sourceId}\u0000${remoteTrackId}`;
}
