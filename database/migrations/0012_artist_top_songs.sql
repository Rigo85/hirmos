ALTER TABLE music_sources
  ADD COLUMN metadata_generation bigint NOT NULL DEFAULT 0
    CHECK (metadata_generation >= 0);

CREATE TABLE artist_top_songs_state (
  source_id uuid NOT NULL REFERENCES music_sources(id) ON DELETE CASCADE,
  remote_artist_id text NOT NULL,
  last_check_outcome text
    CHECK (last_check_outcome IS NULL OR last_check_outcome IN (
      'nonempty', 'empty', 'temporary_error', 'not_found', 'suspect'
    )),
  last_checked_at timestamptz,
  last_nonempty_at timestamptz,
  validated_at timestamptz,
  next_refresh_at timestamptz NOT NULL DEFAULT now(),
  content_hash text CHECK (content_hash IS NULL OR content_hash ~ '^[0-9a-f]{64}$'),
  candidate_hash text CHECK (candidate_hash IS NULL OR candidate_hash ~ '^[0-9a-f]{64}$'),
  consecutive_weak_observations integer NOT NULL DEFAULT 0
    CHECK (consecutive_weak_observations >= 0),
  catalog_generation bigint NOT NULL DEFAULT 0 CHECK (catalog_generation >= 0),
  source_metadata_generation bigint NOT NULL DEFAULT 0
    CHECK (source_metadata_generation >= 0),
  PRIMARY KEY (source_id, remote_artist_id),
  FOREIGN KEY (source_id, remote_artist_id)
    REFERENCES catalog_artists(source_id, remote_artist_id) ON DELETE CASCADE
);

CREATE TABLE artist_top_songs_items (
  source_id uuid NOT NULL,
  remote_artist_id text NOT NULL,
  remote_track_id text NOT NULL,
  rank integer NOT NULL CHECK (rank BETWEEN 1 AND 50),
  PRIMARY KEY (source_id, remote_artist_id, rank),
  UNIQUE (source_id, remote_artist_id, remote_track_id),
  FOREIGN KEY (source_id, remote_artist_id)
    REFERENCES artist_top_songs_state(source_id, remote_artist_id) ON DELETE CASCADE,
  FOREIGN KEY (source_id, remote_track_id)
    REFERENCES catalog_tracks(source_id, remote_track_id) ON DELETE CASCADE
);

CREATE INDEX artist_top_songs_due
  ON artist_top_songs_state (next_refresh_at, source_id)
  WHERE next_refresh_at IS NOT NULL;

INSERT INTO artist_top_songs_state (
  source_id, remote_artist_id, last_check_outcome, last_checked_at,
  last_nonempty_at, validated_at, next_refresh_at
)
SELECT source_id, remote_artist_id,
       CASE WHEN jsonb_array_length(top_tracks) > 0 THEN 'nonempty' ELSE 'empty' END,
       detail_fetched_at,
       CASE WHEN jsonb_array_length(top_tracks) > 0 THEN detail_fetched_at END,
       CASE WHEN jsonb_array_length(top_tracks) > 0 THEN detail_fetched_at END,
       now()
  FROM catalog_artists artist;

INSERT INTO artist_top_songs_items (
  source_id, remote_artist_id, remote_track_id, rank
)
SELECT artist.source_id, artist.remote_artist_id, item.value->>'id', item.ordinality::integer
  FROM catalog_artists artist
 CROSS JOIN LATERAL jsonb_array_elements(artist.top_tracks)
   WITH ORDINALITY AS item(value, ordinality)
  JOIN catalog_tracks track
    ON track.source_id = artist.source_id
   AND track.remote_track_id = item.value->>'id'
 WHERE item.ordinality <= 50
ON CONFLICT DO NOTHING;

ALTER TABLE background_jobs
  DROP CONSTRAINT background_jobs_kind_check;

ALTER TABLE background_jobs
  ADD CONSTRAINT background_jobs_kind_check
  CHECK (kind IN (
    'catalog_sync', 'metadata_refresh', 'lyrics_upgrade', 'cache_gc',
    'image_warm', 'top_songs_refresh'
  ));

CREATE INDEX background_jobs_top_songs_source
  ON background_jobs ((payload->>'sourceId'), status, available_at, priority DESC, id)
  WHERE kind = 'top_songs_refresh';
