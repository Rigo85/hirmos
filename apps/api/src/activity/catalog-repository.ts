import type { Database } from '../db/database.js';
import type {
  SourceAlbum, SourceAlbumDetail, SourceArtist, SourceArtistDetail, SourceTrack,
} from '../music-source/music-source-adapter.js';

export interface CatalogSearchResult {
  artists: SourceArtist[];
  albums: SourceAlbum[];
  tracks: SourceTrack[];
}

export class CatalogRepository {
  public constructor(private readonly db: Database) {}

  public async observeTracks(sourceId: string, tracks: SourceTrack[]): Promise<string[]> {
    if (!tracks.length) return [];
    const result = await this.db.query<{ remote_artist_id: string }>(
      `WITH incoming AS MATERIALIZED (
         SELECT $1::uuid AS source_id, item
           FROM jsonb_array_elements($2::jsonb) AS item
       ), changed AS MATERIALIZED (
         SELECT existing.remote_artist_id AS old_artist_id,
                NULLIF(incoming.item->>'artistId', '') AS new_artist_id
           FROM incoming
           LEFT JOIN catalog_tracks existing
             ON existing.source_id = incoming.source_id
            AND existing.remote_track_id = incoming.item->>'id'
          WHERE existing.remote_track_id IS NULL
             OR existing.missing_since IS NOT NULL
             OR existing.title IS DISTINCT FROM incoming.item->>'title'
             OR existing.artist_name IS DISTINCT FROM incoming.item->>'artist'
             OR existing.remote_artist_id IS DISTINCT FROM NULLIF(incoming.item->>'artistId', '')
             OR existing.musicbrainz_recording_id::text IS DISTINCT FROM
                NULLIF(incoming.item->>'musicBrainzId', '')
       ), saved AS (
       INSERT INTO catalog_tracks
         (source_id, remote_track_id, title, artist_name, remote_artist_id,
          album_name, remote_album_id, duration_ms, cover_art_id, release_year,
          musicbrainz_recording_id,
          genres, track_number, disc_number, bit_rate, bit_depth, sampling_rate,
          channel_count, bpm, replay_gain, source_created_at)
       SELECT $1, item->>'id', item->>'title', item->>'artist',
              NULLIF(item->>'artistId', ''), item->>'album',
              NULLIF(item->>'albumId', ''),
              GREATEST(0, COALESCE((item->>'durationMs')::integer, 0)),
              NULLIF(item->>'coverArtId', ''),
              CASE WHEN item->>'year' IS NULL THEN NULL ELSE (item->>'year')::integer END,
              NULLIF(item->>'musicBrainzId', '')::uuid,
              COALESCE(item->'genres', '[]'::jsonb),
              (item->>'trackNumber')::integer, (item->>'discNumber')::integer,
              (item->>'bitRate')::integer, (item->>'bitDepth')::integer,
              (item->>'samplingRate')::integer, (item->>'channelCount')::integer,
              (item->>'bpm')::integer, item->'replayGain',
              CASE WHEN item->>'createdAt' IS NULL THEN NULL
                   ELSE (item->>'createdAt')::timestamptz END
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
         musicbrainz_recording_id = EXCLUDED.musicbrainz_recording_id,
         genres = EXCLUDED.genres,
         track_number = EXCLUDED.track_number,
         disc_number = EXCLUDED.disc_number,
         bit_rate = EXCLUDED.bit_rate,
         bit_depth = EXCLUDED.bit_depth,
         sampling_rate = EXCLUDED.sampling_rate,
         channel_count = EXCLUDED.channel_count,
         bpm = EXCLUDED.bpm,
         replay_gain = EXCLUDED.replay_gain,
         source_created_at = EXCLUDED.source_created_at,
         missing_since = NULL,
         missing_syncs = 0,
         last_seen_at = now()
       RETURNING remote_track_id
       )
       SELECT DISTINCT remote_artist_id
         FROM (
           SELECT old_artist_id AS remote_artist_id FROM changed
           UNION SELECT new_artist_id FROM changed
         ) affected
        WHERE remote_artist_id IS NOT NULL`,
      [sourceId, JSON.stringify(tracks)],
    );
    return result.rows.map((row) => row.remote_artist_id);
  }

  public async observeAlbums(sourceId: string, albums: SourceAlbum[]): Promise<void> {
    if (!albums.length) return;
    await this.db.query(
      `INSERT INTO catalog_albums
         (source_id, remote_album_id, name, artist_name, remote_artist_id,
          cover_art_id, song_count, duration_ms, release_year, genres, source_created_at,
          play_count, last_played_at)
       SELECT $1, item->>'id', item->>'name', item->>'artist',
              NULLIF(item->>'artistId', ''), NULLIF(item->>'coverArtId', ''),
              GREATEST(0, COALESCE((item->>'songCount')::integer, 0)),
              GREATEST(0, COALESCE((item->>'durationMs')::integer, 0)),
              CASE WHEN item->>'year' IS NULL THEN NULL ELSE (item->>'year')::integer END,
              COALESCE(item->'genres', '[]'::jsonb),
              CASE WHEN item->>'createdAt' IS NULL THEN NULL
                   ELSE (item->>'createdAt')::timestamptz END,
              (item->>'playCount')::integer,
              CASE WHEN item->>'lastPlayedAt' IS NULL THEN NULL
                   ELSE (item->>'lastPlayedAt')::timestamptz END
         FROM jsonb_array_elements($2::jsonb) AS item
       ON CONFLICT (source_id, remote_album_id) DO UPDATE SET
         name = EXCLUDED.name,
         artist_name = EXCLUDED.artist_name,
         remote_artist_id = EXCLUDED.remote_artist_id,
         cover_art_id = EXCLUDED.cover_art_id,
         song_count = EXCLUDED.song_count,
         duration_ms = EXCLUDED.duration_ms,
         release_year = EXCLUDED.release_year,
         genres = EXCLUDED.genres,
         source_created_at = EXCLUDED.source_created_at,
         play_count = EXCLUDED.play_count,
         last_played_at = EXCLUDED.last_played_at,
         missing_since = NULL,
         missing_syncs = 0,
         last_seen_at = now()`,
      [sourceId, JSON.stringify(albums)],
    );
  }

  public async observeArtists(sourceId: string, artists: SourceArtist[]): Promise<string[]> {
    if (!artists.length) return [];
    const result = await this.db.query<{ remote_artist_id: string }>(
      `WITH incoming AS MATERIALIZED (
         SELECT $1::uuid AS source_id, item
           FROM jsonb_array_elements($2::jsonb) AS item
       ), changed AS MATERIALIZED (
         SELECT item->>'id' AS remote_artist_id
           FROM incoming
           LEFT JOIN catalog_artists existing
             ON existing.source_id = incoming.source_id
            AND existing.remote_artist_id = incoming.item->>'id'
          WHERE existing.remote_artist_id IS NULL
             OR existing.missing_since IS NOT NULL
             OR existing.name IS DISTINCT FROM incoming.item->>'name'
             OR existing.musicbrainz_artist_id::text IS DISTINCT FROM
                NULLIF(incoming.item->>'musicBrainzId', '')
       ), saved AS (
       INSERT INTO catalog_artists
         (source_id, remote_artist_id, name, cover_art_id, album_count,
          musicbrainz_artist_id)
       SELECT incoming.source_id, item->>'id', item->>'name', NULLIF(item->>'coverArtId', ''),
              GREATEST(0, COALESCE((item->>'albumCount')::integer, 0)),
              NULLIF(item->>'musicBrainzId', '')::uuid
         FROM incoming
       ON CONFLICT (source_id, remote_artist_id) DO UPDATE SET
         name = EXCLUDED.name,
         cover_art_id = EXCLUDED.cover_art_id,
         album_count = EXCLUDED.album_count,
         musicbrainz_artist_id = EXCLUDED.musicbrainz_artist_id,
         missing_since = NULL,
         missing_syncs = 0,
         last_seen_at = now()
       RETURNING remote_artist_id
       )
       SELECT remote_artist_id FROM changed`,
      [sourceId, JSON.stringify(artists)],
    );
    return result.rows.map((row) => row.remote_artist_id);
  }

  public async observeArtistDetail(sourceId: string, artist: SourceArtistDetail): Promise<void> {
    await Promise.all([
      // Related artists are enrichment evidence, not proof of catalog membership.
      // Only a full source sync may add them to the browsable artist mirror.
      this.observeArtists(sourceId, [artist]),
      this.observeAlbums(sourceId, artist.albums),
      this.observeTracks(sourceId, artist.topTracks),
    ]);
    const externalInfoAvailable = artist.externalInfoAvailable !== false;
    const topTracksAvailable = artist.topTracksAvailable !== false;
    await this.db.query(
      `UPDATE catalog_artists
          SET biography = CASE WHEN $7::boolean THEN COALESCE($3, biography) ELSE biography END,
              external_url = CASE WHEN $7::boolean THEN COALESCE($4, external_url) ELSE external_url END,
              similar_artists = CASE WHEN $7::boolean AND jsonb_array_length($5::jsonb) > 0
                THEN $5::jsonb ELSE similar_artists END,
              top_tracks = CASE WHEN $8::boolean AND jsonb_array_length($6::jsonb) > 0
                THEN $6::jsonb ELSE top_tracks END,
              detail_fetched_at = CASE WHEN $7::boolean
                THEN now() ELSE detail_fetched_at END,
              last_seen_at = now(),
              missing_since = NULL
        WHERE source_id = $1 AND remote_artist_id = $2`,
      [sourceId, artist.id, artist.biography, artist.externalUrl,
       JSON.stringify(artist.similarArtists), JSON.stringify(artist.topTracks),
       externalInfoAvailable, topTracksAvailable],
    );
  }

  public async artistDetail(sourceId: string, remoteArtistId: string): Promise<{
    detail: SourceArtistDetail;
    fetchedAt: Date;
  } | null> {
    const result = await this.db.query<ArtistDetailRow>(
      `SELECT remote_artist_id, name, cover_art_id, album_count, musicbrainz_artist_id,
              biography, external_url, similar_artists, top_tracks, detail_fetched_at
         FROM catalog_artists
        WHERE source_id = $1 AND remote_artist_id = $2 AND missing_since IS NULL
          AND detail_fetched_at IS NOT NULL`,
      [sourceId, remoteArtistId],
    );
    const row = result.rows[0];
    if (!row?.detail_fetched_at) return null;
    const albums = await this.db.query<AlbumRow>(
      `SELECT remote_album_id, name, artist_name, remote_artist_id, cover_art_id,
              song_count, duration_ms, release_year, genres, musicbrainz_release_id,
              play_count, last_played_at, source_created_at
         FROM catalog_albums
        WHERE source_id = $1 AND remote_artist_id = $2 AND missing_since IS NULL
        ORDER BY release_year NULLS LAST, lower(name)`,
      [sourceId, remoteArtistId],
    );
    return {
      fetchedAt: row.detail_fetched_at,
      detail: {
        ...mapArtistRow(row),
        albums: albums.rows.map(mapAlbumRow),
        biography: row.biography,
        externalUrl: row.external_url,
        similarArtists: row.similar_artists,
        topTracks: row.top_tracks,
      },
    };
  }

  public async albumDetail(sourceId: string, remoteAlbumId: string): Promise<SourceAlbumDetail | null> {
    const album = await this.db.query<AlbumRow>(
      `SELECT remote_album_id, name, artist_name, remote_artist_id, cover_art_id,
              song_count, duration_ms, release_year, genres, musicbrainz_release_id,
              play_count, last_played_at, source_created_at
         FROM catalog_albums
        WHERE source_id = $1 AND remote_album_id = $2 AND missing_since IS NULL`,
      [sourceId, remoteAlbumId],
    );
    const row = album.rows[0];
    if (!row) return null;
    const tracks = await this.db.query<TrackRow>(
      `${trackSelect()}
        WHERE source_id = $1 AND remote_album_id = $2 AND missing_since IS NULL
        ORDER BY disc_number NULLS LAST, track_number NULLS LAST, lower(title)`,
      [sourceId, remoteAlbumId],
    );
    return { ...mapAlbumRow(row), tracks: tracks.rows.map(mapTrackRow) };
  }

  public async beginSync(sourceId: string): Promise<{ id: number; startedAt: Date }> {
    const result = await this.db.query<{ id: string; started_at: Date }>(
      `INSERT INTO catalog_sync_runs (source_id, status)
       VALUES ($1, 'running') RETURNING id, started_at`,
      [sourceId],
    );
    const row = result.rows[0];
    if (!row) throw new Error('Could not start catalog sync');
    return { id: Number(row.id), startedAt: row.started_at };
  }

  public async isReady(sourceId: string): Promise<boolean> {
    const result = await this.db.query<{ ready: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM catalog_sync_runs WHERE source_id = $1 AND status = 'succeeded'
       ) AS ready`,
      [sourceId],
    );
    return Boolean(result.rows[0]?.ready);
  }

  public async stats(sourceId: string): Promise<{
    artists: number; albums: number; tracks: number; genres: number; syncedAt: Date | null;
  }> {
    const result = await this.db.query<{
      artists: string; albums: string; tracks: string; genres: string; synced_at: Date | null;
    }>(
      `SELECT
         (SELECT count(*) FROM catalog_artists
           WHERE source_id = $1 AND missing_since IS NULL)::text AS artists,
         (SELECT count(*) FROM catalog_albums
           WHERE source_id = $1 AND missing_since IS NULL)::text AS albums,
         (SELECT count(*) FROM catalog_tracks
           WHERE source_id = $1 AND missing_since IS NULL)::text AS tracks,
         (SELECT count(DISTINCT lower(value))
            FROM (
              SELECT jsonb_array_elements_text(genres) AS value
                FROM catalog_albums WHERE source_id = $1 AND missing_since IS NULL
              UNION ALL
              SELECT jsonb_array_elements_text(genres) AS value
                FROM catalog_tracks WHERE source_id = $1 AND missing_since IS NULL
            ) genre_values)::text AS genres,
         (SELECT max(completed_at) FROM catalog_sync_runs
           WHERE source_id = $1 AND status = 'succeeded') AS synced_at`,
      [sourceId],
    );
    const row = result.rows[0];
    return {
      artists: Number(row?.artists ?? 0),
      albums: Number(row?.albums ?? 0),
      tracks: Number(row?.tracks ?? 0),
      genres: Number(row?.genres ?? 0),
      syncedAt: row?.synced_at ?? null,
    };
  }

  public async listArtists(sourceId: string, limit: number, offset: number): Promise<SourceArtist[]> {
    const result = await this.db.query<ArtistRow>(
      `SELECT remote_artist_id, name, cover_art_id, album_count, musicbrainz_artist_id
         FROM catalog_artists
        WHERE source_id = $1 AND missing_since IS NULL
        ORDER BY lower(name), remote_artist_id LIMIT $2 OFFSET $3`,
      [sourceId, limit, offset],
    );
    return result.rows.map(mapArtistRow);
  }

  public async listAlbums(
    sourceId: string,
    sort: 'random' | 'newest' | 'frequent' | 'recent' | 'alphabeticalByName',
    limit: number,
    offset: number,
    year?: number,
  ): Promise<SourceAlbum[]> {
    const order = {
      random: 'random()',
      newest: 'source_created_at DESC NULLS LAST, lower(name)',
      frequent: 'play_count DESC NULLS LAST, lower(name)',
      recent: 'last_played_at DESC NULLS LAST, lower(name)',
      alphabeticalByName: 'lower(name), remote_album_id',
    }[sort];
    const result = await this.db.query<AlbumRow>(
      `SELECT remote_album_id, name, artist_name, remote_artist_id, cover_art_id,
              song_count, duration_ms, release_year, genres, musicbrainz_release_id,
              play_count, last_played_at, source_created_at
         FROM catalog_albums
        WHERE source_id = $1 AND missing_since IS NULL
          AND ($4::integer IS NULL OR release_year = $4)
        ORDER BY ${order} LIMIT $2 OFFSET $3`,
      [sourceId, limit, offset, year ?? null],
    );
    return result.rows.map(mapAlbumRow);
  }

  public async listTracks(sourceId: string, limit: number, offset: number): Promise<SourceTrack[]> {
    const result = await this.db.query<TrackRow>(
      `${trackSelect()}
        WHERE source_id = $1 AND missing_since IS NULL
        ORDER BY lower(title), remote_track_id LIMIT $2 OFFSET $3`,
      [sourceId, limit, offset],
    );
    return result.rows.map(mapTrackRow);
  }

  public async randomTracks(sourceId: string, limit: number): Promise<SourceTrack[]> {
    const result = await this.db.query<TrackRow>(
      `${trackSelect()}
        WHERE source_id = $1 AND missing_since IS NULL
        ORDER BY random() LIMIT $2`,
      [sourceId, limit],
    );
    return result.rows.map(mapTrackRow);
  }

  public async search(
    sourceId: string,
    query: string,
    offset: number,
  ): Promise<CatalogSearchResult> {
    const pattern = `%${query}%`;
    const [artists, albums, tracks] = await Promise.all([
      this.db.query<ArtistRow>(
        `SELECT remote_artist_id, name, cover_art_id, album_count, musicbrainz_artist_id
           FROM catalog_artists
          WHERE source_id = $1 AND missing_since IS NULL AND name ILIKE $2
          ORDER BY (lower(name) = lower($3)) DESC,
                   (lower(name) LIKE lower($3) || '%') DESC, lower(name)
          LIMIT 12 OFFSET $4`,
        [sourceId, pattern, query, offset],
      ),
      this.db.query<AlbumRow>(
        `SELECT remote_album_id, name, artist_name, remote_artist_id, cover_art_id,
                song_count, duration_ms, release_year, genres, musicbrainz_release_id,
                play_count, last_played_at, source_created_at
           FROM catalog_albums
          WHERE source_id = $1 AND missing_since IS NULL
            AND (name ILIKE $2 OR artist_name ILIKE $2)
          ORDER BY (lower(name) = lower($3)) DESC,
                   (lower(name) LIKE lower($3) || '%') DESC, lower(name)
          LIMIT 12 OFFSET $4`,
        [sourceId, pattern, query, offset],
      ),
      this.db.query<TrackRow>(
        `${trackSelect()}
          WHERE source_id = $1 AND missing_since IS NULL
            AND (title ILIKE $2 OR artist_name ILIKE $2 OR album_name ILIKE $2)
          ORDER BY (lower(title) = lower($3)) DESC,
                   (lower(title) LIKE lower($3) || '%') DESC, lower(title)
          LIMIT 50 OFFSET $4`,
        [sourceId, pattern, query, offset],
      ),
    ]);
    return {
      artists: artists.rows.map(mapArtistRow),
      albums: albums.rows.map(mapAlbumRow),
      tracks: tracks.rows.map(mapTrackRow),
    };
  }

  public async listAlbumsByGenre(sourceId: string, genre: string, limit: number): Promise<SourceAlbum[]> {
    const result = await this.db.query<AlbumRow>(
      `SELECT remote_album_id, name, artist_name, remote_artist_id, cover_art_id,
              song_count, duration_ms, release_year, genres, musicbrainz_release_id,
              play_count, last_played_at, source_created_at
         FROM catalog_albums
        WHERE source_id = $1 AND missing_since IS NULL
          AND EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(genres) item
             WHERE lower(item) = lower($2)
          )
        ORDER BY lower(name), remote_album_id LIMIT $3`,
      [sourceId, genre, limit],
    );
    return result.rows.map(mapAlbumRow);
  }

  public async listTracksByGenre(sourceId: string, genre: string, limit: number): Promise<SourceTrack[]> {
    const result = await this.db.query<TrackRow>(
      `${trackSelect()}
        WHERE source_id = $1 AND missing_since IS NULL
          AND EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(genres) item
             WHERE lower(item) = lower($2)
          )
        ORDER BY lower(title), remote_track_id LIMIT $3`,
      [sourceId, genre, limit],
    );
    return result.rows.map(mapTrackRow);
  }

  public async listGenres(sourceId: string): Promise<Array<{
    name: string; albumCount: number; songCount: number;
  }>> {
    const result = await this.db.query<{ name: string; album_count: string; song_count: string }>(
      `WITH album_genres AS (
         SELECT DISTINCT remote_album_id, jsonb_array_elements_text(genres) AS name
           FROM catalog_albums WHERE source_id = $1 AND missing_since IS NULL
       ), track_genres AS (
         SELECT DISTINCT remote_track_id, jsonb_array_elements_text(genres) AS name
           FROM catalog_tracks WHERE source_id = $1 AND missing_since IS NULL
       ), names AS (
         SELECT name FROM album_genres UNION SELECT name FROM track_genres
       )
       SELECT names.name,
              (SELECT count(*) FROM album_genres WHERE lower(album_genres.name) = lower(names.name)) AS album_count,
              (SELECT count(*) FROM track_genres WHERE lower(track_genres.name) = lower(names.name)) AS song_count
         FROM names ORDER BY lower(names.name)`,
      [sourceId],
    );
    return result.rows.map((row) => ({
      name: row.name, albumCount: Number(row.album_count), songCount: Number(row.song_count),
    }));
  }

  public async finishSync(input: {
    id: number;
    sourceId: string;
    startedAt: Date;
    artists: number;
    albums: number;
    tracks: number;
  }): Promise<string[]> {
    const result = await this.db.query<{ remote_artist_id: string }>(
      `WITH newly_missing_tracks AS MATERIALIZED (
         SELECT remote_artist_id
           FROM catalog_tracks
          WHERE source_id = $2 AND last_seen_at < $3
            AND missing_since IS NULL AND missing_syncs + 1 >= 2
       ), missing_tracks AS (
         UPDATE catalog_tracks
            SET missing_syncs = missing_syncs + 1,
                missing_since = CASE WHEN missing_syncs + 1 >= 2
                  THEN COALESCE(missing_since, now()) ELSE NULL END
          WHERE source_id = $2 AND last_seen_at < $3
       ), missing_albums AS (
         UPDATE catalog_albums
            SET missing_syncs = missing_syncs + 1,
                missing_since = CASE WHEN missing_syncs + 1 >= 2
                  THEN COALESCE(missing_since, now()) ELSE NULL END
          WHERE source_id = $2 AND last_seen_at < $3
       ), missing_artists AS (
         UPDATE catalog_artists
            SET missing_syncs = missing_syncs + 1,
                missing_since = CASE WHEN missing_syncs + 1 >= 2
                  THEN COALESCE(missing_since, now()) ELSE NULL END
          WHERE source_id = $2 AND last_seen_at < $3
       ), source_updated AS (
         UPDATE music_sources SET last_synced_at = now() WHERE id = $2
       ), completed_run AS (
       UPDATE catalog_sync_runs
          SET status = 'succeeded', completed_at = now(), artist_count = $4,
              album_count = $5, track_count = $6, error_code = NULL
        WHERE id = $1
       )
       SELECT DISTINCT remote_artist_id
         FROM newly_missing_tracks
        WHERE remote_artist_id IS NOT NULL`,
      [input.id, input.sourceId, input.startedAt, input.artists, input.albums, input.tracks],
    );
    return result.rows.map((row) => row.remote_artist_id);
  }

  public async failSync(id: number, errorCode: string): Promise<void> {
    await this.db.query(
      `UPDATE catalog_sync_runs
          SET status = 'failed', completed_at = now(), error_code = $2
        WHERE id = $1`,
      [id, errorCode.slice(0, 100)],
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

  public async tracksByIds(sourceId: string, remoteTrackIds: string[]): Promise<SourceTrack[]> {
    if (!remoteTrackIds.length) return [];
    const result = await this.db.query<TrackRow>(
      `${trackSelect()}
        WHERE source_id = $1 AND remote_track_id = ANY($2::text[])
          AND missing_since IS NULL
        ORDER BY array_position($2::text[], remote_track_id)`,
      [sourceId, remoteTrackIds],
    );
    return result.rows.map(mapTrackRow);
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

interface ArtistRow {
  remote_artist_id: string; name: string; cover_art_id: string | null;
  album_count: number; musicbrainz_artist_id: string | null;
}

interface ArtistDetailRow extends ArtistRow {
  biography: string | null;
  external_url: string | null;
  similar_artists: SourceArtist[];
  top_tracks: SourceTrack[];
  detail_fetched_at: Date | null;
}

interface AlbumRow {
  remote_album_id: string; name: string; artist_name: string; remote_artist_id: string | null;
  cover_art_id: string | null; song_count: number; duration_ms: number;
  release_year: number | null; genres: string[]; musicbrainz_release_id: string | null;
  play_count: number | null; last_played_at: Date | null; source_created_at: Date | null;
}

interface TrackRow {
  remote_track_id: string; title: string; artist_name: string;
  remote_artist_id: string | null; album_name: string; remote_album_id: string | null;
  duration_ms: number; cover_art_id: string | null; release_year: number | null;
  genres: string[]; musicbrainz_recording_id: string | null; track_number: number | null;
  disc_number: number | null; bit_rate: number | null; bit_depth: number | null;
  sampling_rate: number | null; channel_count: number | null; bpm: number | null;
  replay_gain: Record<string, number> | null; source_created_at: Date | null;
}

function trackSelect(): string {
  return `SELECT remote_track_id, title, artist_name, remote_artist_id, album_name,
                 remote_album_id, duration_ms, cover_art_id, release_year, genres,
                 musicbrainz_recording_id, track_number, disc_number, bit_rate,
                 bit_depth, sampling_rate, channel_count, bpm, replay_gain,
                 source_created_at
            FROM catalog_tracks`;
}

function mapArtistRow(row: ArtistRow): SourceArtist {
  return {
    id: row.remote_artist_id, name: row.name, coverArtId: row.cover_art_id,
    albumCount: row.album_count, favorite: false, musicBrainzId: row.musicbrainz_artist_id,
  };
}

function mapAlbumRow(row: AlbumRow): SourceAlbum {
  return {
    id: row.remote_album_id, name: row.name, artist: row.artist_name,
    artistId: row.remote_artist_id, coverArtId: row.cover_art_id,
    songCount: row.song_count, durationMs: row.duration_ms, year: row.release_year,
    genre: row.genres[0] ?? null, genres: row.genres,
    musicBrainzId: row.musicbrainz_release_id, favorite: false,
    playCount: row.play_count, lastPlayedAt: row.last_played_at?.toISOString() ?? null,
    createdAt: row.source_created_at?.toISOString() ?? null,
  };
}

function mapTrackRow(row: TrackRow): SourceTrack {
  return {
    id: row.remote_track_id, title: row.title, artist: row.artist_name,
    artistId: row.remote_artist_id, album: row.album_name, albumId: row.remote_album_id,
    durationMs: row.duration_ms, coverArtId: row.cover_art_id, year: row.release_year,
    genres: row.genres, musicBrainzId: row.musicbrainz_recording_id, favorite: false,
    trackNumber: row.track_number, discNumber: row.disc_number, bitRate: row.bit_rate,
    bitDepth: row.bit_depth, samplingRate: row.sampling_rate,
    channelCount: row.channel_count, bpm: row.bpm, replayGain: row.replay_gain,
    createdAt: row.source_created_at?.toISOString() ?? null,
  };
}
