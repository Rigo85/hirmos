import type { Database } from '../db/database.js';
import type { SourceArtist, SourceTrack } from '../music-source/music-source-adapter.js';

export class CatalogRepository {
  public constructor(private readonly db: Database) {}

  public async observeTracks(sourceId: string, tracks: SourceTrack[]): Promise<void> {
    if (!tracks.length) return;
    await this.db.query(
      `INSERT INTO catalog_tracks
         (source_id, remote_track_id, title, artist_name, remote_artist_id,
          album_name, remote_album_id, duration_ms, cover_art_id, release_year)
       SELECT $1, item->>'id', item->>'title', item->>'artist',
              NULLIF(item->>'artistId', ''), item->>'album',
              NULLIF(item->>'albumId', ''),
              GREATEST(0, COALESCE((item->>'durationMs')::integer, 0)),
              NULLIF(item->>'coverArtId', ''),
              CASE WHEN item->>'year' IS NULL THEN NULL ELSE (item->>'year')::integer END
         FROM jsonb_array_elements($2::jsonb) AS item
       ON CONFLICT (source_id, remote_track_id) DO UPDATE SET
         title = EXCLUDED.title,
         artist_name = EXCLUDED.artist_name,
         remote_artist_id = EXCLUDED.remote_artist_id,
         album_name = EXCLUDED.album_name,
         remote_album_id = EXCLUDED.remote_album_id,
         duration_ms = EXCLUDED.duration_ms,
         cover_art_id = EXCLUDED.cover_art_id,
         release_year = EXCLUDED.release_year,
         last_seen_at = now()`,
      [sourceId, JSON.stringify(tracks)],
    );
  }

  public async observeArtists(sourceId: string, artists: SourceArtist[]): Promise<void> {
    if (!artists.length) return;
    await this.db.query(
      `INSERT INTO catalog_artists
         (source_id, remote_artist_id, name, cover_art_id, album_count)
       SELECT $1, item->>'id', item->>'name', NULLIF(item->>'coverArtId', ''),
              GREATEST(0, COALESCE((item->>'albumCount')::integer, 0))
         FROM jsonb_array_elements($2::jsonb) AS item
       ON CONFLICT (source_id, remote_artist_id) DO UPDATE SET
         name = EXCLUDED.name,
         cover_art_id = EXCLUDED.cover_art_id,
         album_count = EXCLUDED.album_count,
         last_seen_at = now()`,
      [sourceId, JSON.stringify(artists)],
    );
  }

  public async missingTrackIds(sourceId: string, remoteTrackIds: string[]): Promise<string[]> {
    if (!remoteTrackIds.length) return [];
    const result = await this.db.query<{ remote_track_id: string }>(
      `SELECT requested.remote_track_id
         FROM unnest($2::text[]) AS requested(remote_track_id)
         LEFT JOIN catalog_tracks track
           ON track.source_id = $1 AND track.remote_track_id = requested.remote_track_id
        WHERE track.remote_track_id IS NULL`,
      [sourceId, remoteTrackIds],
    );
    return result.rows.map((row) => row.remote_track_id);
  }

  public async missingArtistIds(sourceId: string, remoteTrackIds: string[]): Promise<string[]> {
    if (!remoteTrackIds.length) return [];
    const result = await this.db.query<{ remote_artist_id: string }>(
      `SELECT DISTINCT track.remote_artist_id
         FROM catalog_tracks track
         LEFT JOIN catalog_artists artist
           ON artist.source_id = track.source_id
          AND artist.remote_artist_id = track.remote_artist_id
        WHERE track.source_id = $1
          AND track.remote_track_id = ANY($2::text[])
          AND track.remote_artist_id IS NOT NULL
          AND artist.remote_artist_id IS NULL`,
      [sourceId, remoteTrackIds],
    );
    return result.rows.map((row) => row.remote_artist_id);
  }
}
