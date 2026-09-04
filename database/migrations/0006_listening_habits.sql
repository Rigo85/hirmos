ALTER TABLE user_track_stats
  ADD COLUMN qualified_plays integer NOT NULL DEFAULT 0
    CHECK (qualified_plays >= 0);

UPDATE user_track_stats
   SET qualified_plays = completions;

CREATE TABLE user_track_daily_stats (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_id uuid NOT NULL REFERENCES music_sources(id) ON DELETE CASCADE,
  remote_track_id text NOT NULL,
  stat_date date NOT NULL,
  play_starts integer NOT NULL DEFAULT 0 CHECK (play_starts >= 0),
  qualified_plays integer NOT NULL DEFAULT 0 CHECK (qualified_plays >= 0),
  completions integer NOT NULL DEFAULT 0 CHECK (completions >= 0),
  skips integer NOT NULL DEFAULT 0 CHECK (skips >= 0),
  listened_ms bigint NOT NULL DEFAULT 0 CHECK (listened_ms >= 0),
  first_played_at timestamptz,
  last_played_at timestamptz,
  estimated boolean NOT NULL DEFAULT false,
  PRIMARY KEY (user_id, source_id, remote_track_id, stat_date)
);

CREATE INDEX user_track_daily_stats_user_date
  ON user_track_daily_stats (user_id, stat_date DESC);
CREATE INDEX user_track_daily_stats_user_listened
  ON user_track_daily_stats (user_id, stat_date DESC, listened_ms DESC);

-- The original aggregate did not retain progress by date. Existing beta data is
-- small and is assigned to the last observed UTC day, explicitly marked as an
-- estimate. All future increments are written to their actual UTC day.
INSERT INTO user_track_daily_stats
  (user_id, source_id, remote_track_id, stat_date, play_starts,
   qualified_plays, completions, skips, listened_ms, first_played_at,
   last_played_at, estimated)
SELECT user_id, source_id, remote_track_id,
       (COALESCE(last_played_at, last_observed_at, now()) AT TIME ZONE 'UTC')::date,
       play_starts, qualified_plays, completions, skips, listened_ms,
       first_played_at, last_played_at, true
  FROM user_track_stats;

CREATE TABLE catalog_tracks (
  source_id uuid NOT NULL REFERENCES music_sources(id) ON DELETE CASCADE,
  remote_track_id text NOT NULL,
  title text NOT NULL,
  artist_name text NOT NULL,
  remote_artist_id text,
  album_name text NOT NULL,
  remote_album_id text,
  duration_ms integer NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
  cover_art_id text,
  release_year integer,
  musicbrainz_recording_id uuid,
  musicbrainz_artist_id uuid,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id, remote_track_id)
);

CREATE INDEX catalog_tracks_artist
  ON catalog_tracks (source_id, remote_artist_id);
CREATE INDEX catalog_tracks_album
  ON catalog_tracks (source_id, remote_album_id);

CREATE TABLE catalog_artists (
  source_id uuid NOT NULL REFERENCES music_sources(id) ON DELETE CASCADE,
  remote_artist_id text NOT NULL,
  name text NOT NULL,
  cover_art_id text,
  album_count integer NOT NULL DEFAULT 0 CHECK (album_count >= 0),
  musicbrainz_artist_id uuid,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id, remote_artist_id)
);

CREATE TABLE canonical_artists (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 300),
  musicbrainz_artist_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX canonical_artists_musicbrainz_unique
  ON canonical_artists (musicbrainz_artist_id)
  WHERE musicbrainz_artist_id IS NOT NULL;

CREATE TABLE canonical_artist_members (
  canonical_artist_id uuid NOT NULL REFERENCES canonical_artists(id) ON DELETE CASCADE,
  source_id uuid NOT NULL REFERENCES music_sources(id) ON DELETE CASCADE,
  remote_artist_id text NOT NULL,
  linked_by text NOT NULL CHECK (linked_by IN ('musicbrainz', 'manual', 'import')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id, remote_artist_id),
  UNIQUE (canonical_artist_id, source_id, remote_artist_id)
);

CREATE TABLE imported_listens (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_id uuid NOT NULL REFERENCES music_sources(id) ON DELETE CASCADE,
  provider text NOT NULL,
  external_event_id text NOT NULL,
  remote_track_id text NOT NULL,
  occurred_at timestamptz NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, source_id, provider, external_event_id)
);

CREATE INDEX imported_listens_user_time
  ON imported_listens (user_id, occurred_at DESC);
