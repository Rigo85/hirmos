ALTER TABLE catalog_tracks
  ADD COLUMN genres jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN track_number integer,
  ADD COLUMN disc_number integer,
  ADD COLUMN bit_rate integer,
  ADD COLUMN bit_depth integer,
  ADD COLUMN sampling_rate integer,
  ADD COLUMN channel_count integer,
  ADD COLUMN bpm integer,
  ADD COLUMN replay_gain jsonb,
  ADD COLUMN source_created_at timestamptz,
  ADD COLUMN missing_since timestamptz,
  ADD COLUMN missing_syncs integer NOT NULL DEFAULT 0 CHECK (missing_syncs >= 0);

ALTER TABLE catalog_artists
  ADD COLUMN missing_since timestamptz,
  ADD COLUMN biography text,
  ADD COLUMN external_url text,
  ADD COLUMN similar_artists jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN top_tracks jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN detail_fetched_at timestamptz,
  ADD COLUMN missing_syncs integer NOT NULL DEFAULT 0 CHECK (missing_syncs >= 0);

CREATE TABLE catalog_albums (
  source_id uuid NOT NULL REFERENCES music_sources(id) ON DELETE CASCADE,
  remote_album_id text NOT NULL,
  name text NOT NULL,
  artist_name text NOT NULL,
  remote_artist_id text,
  cover_art_id text,
  song_count integer NOT NULL DEFAULT 0 CHECK (song_count >= 0),
  duration_ms integer NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
  release_year integer,
  genres jsonb NOT NULL DEFAULT '[]'::jsonb,
  musicbrainz_release_id uuid,
  play_count integer,
  last_played_at timestamptz,
  source_created_at timestamptz,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  missing_since timestamptz,
  missing_syncs integer NOT NULL DEFAULT 0 CHECK (missing_syncs >= 0),
  PRIMARY KEY (source_id, remote_album_id)
);

CREATE INDEX catalog_albums_artist
  ON catalog_albums (source_id, remote_artist_id);
CREATE INDEX catalog_albums_name
  ON catalog_albums (source_id, lower(name));
CREATE INDEX catalog_tracks_title
  ON catalog_tracks (source_id, lower(title));
CREATE INDEX catalog_artists_name
  ON catalog_artists (source_id, lower(name));

CREATE TABLE catalog_sync_runs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id uuid NOT NULL REFERENCES music_sources(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  artist_count integer NOT NULL DEFAULT 0 CHECK (artist_count >= 0),
  album_count integer NOT NULL DEFAULT 0 CHECK (album_count >= 0),
  track_count integer NOT NULL DEFAULT 0 CHECK (track_count >= 0),
  error_code text
);

CREATE INDEX catalog_sync_runs_source_time
  ON catalog_sync_runs (source_id, started_at DESC);

CREATE TABLE cache_entries (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  namespace text NOT NULL CHECK (namespace IN ('image', 'lyrics', 'provider', 'analysis')),
  cache_key text NOT NULL,
  source_id uuid REFERENCES music_sources(id) ON DELETE CASCADE,
  entity_type text CHECK (entity_type IS NULL OR entity_type IN ('artist', 'album', 'track')),
  remote_entity_id text,
  variant text NOT NULL DEFAULT 'original',
  object_hash text NOT NULL CHECK (object_hash ~ '^[0-9a-f]{64}$'),
  relative_path text NOT NULL,
  content_type text NOT NULL,
  byte_length bigint NOT NULL CHECK (byte_length >= 0),
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  fetched_at timestamptz NOT NULL DEFAULT now(),
  validated_at timestamptz NOT NULL DEFAULT now(),
  last_accessed_at timestamptz NOT NULL DEFAULT now(),
  access_count bigint NOT NULL DEFAULT 0 CHECK (access_count >= 0),
  next_refresh_at timestamptz,
  protected_until timestamptz,
  UNIQUE (namespace, cache_key)
);

CREATE INDEX cache_entries_eviction
  ON cache_entries (namespace, protected_until, last_accessed_at, byte_length DESC);
CREATE INDEX cache_entries_object
  ON cache_entries (object_hash);

ALTER TABLE lyrics_cache
  ADD COLUMN quality text NOT NULL DEFAULT 'plain'
    CHECK (quality IN ('plain', 'line', 'word')),
  ADD COLUMN raw_object_key text,
  ADD COLUMN parser_version text,
  ADD COLUMN content_hash text,
  ADD COLUMN last_accessed_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN access_count bigint NOT NULL DEFAULT 0 CHECK (access_count >= 0);

UPDATE lyrics_cache
   SET quality = CASE
     WHEN EXISTS (
       SELECT 1 FROM jsonb_array_elements(lines) line
        WHERE jsonb_array_length(COALESCE(line->'words', '[]'::jsonb)) > 0
     ) THEN 'word'
     WHEN synced THEN 'line'
     ELSE 'plain'
   END;

ALTER TABLE metadata_provider_cache
  ADD COLUMN content_hash text,
  ADD COLUMN validated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN next_refresh_at timestamptz,
  ADD COLUMN last_accessed_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN access_count bigint NOT NULL DEFAULT 0 CHECK (access_count >= 0);

CREATE TABLE background_jobs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('catalog_sync', 'metadata_refresh', 'lyrics_upgrade', 'cache_gc')),
  dedupe_key text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  priority integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_owner text,
  lease_expires_at timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, dedupe_key)
);

CREATE INDEX background_jobs_claimable
  ON background_jobs (status, available_at, priority DESC, id)
  WHERE status IN ('pending', 'failed');
