CREATE TABLE listen_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_id uuid NOT NULL REFERENCES music_sources(id) ON DELETE CASCADE,
  remote_track_id text NOT NULL,
  queue_item_id uuid REFERENCES queue_items(id) ON DELETE SET NULL,
  device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
  event_type text NOT NULL CHECK (event_type IN
    ('started', 'resumed', 'paused', 'progressed', 'seeked', 'skipped', 'completed')),
  position_ms integer NOT NULL DEFAULT 0 CHECK (position_ms >= 0),
  listened_ms integer NOT NULL DEFAULT 0 CHECK (listened_ms >= 0),
  context_type text,
  context_ref text,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX listen_events_user_time
  ON listen_events (user_id, occurred_at DESC);
CREATE INDEX listen_events_user_track_time
  ON listen_events (user_id, source_id, remote_track_id, occurred_at DESC);

CREATE TABLE user_track_stats (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_id uuid NOT NULL REFERENCES music_sources(id) ON DELETE CASCADE,
  remote_track_id text NOT NULL,
  play_starts integer NOT NULL DEFAULT 0 CHECK (play_starts >= 0),
  completions integer NOT NULL DEFAULT 0 CHECK (completions >= 0),
  skips integer NOT NULL DEFAULT 0 CHECK (skips >= 0),
  listened_ms bigint NOT NULL DEFAULT 0 CHECK (listened_ms >= 0),
  first_played_at timestamptz,
  last_played_at timestamptz,
  last_position_ms integer NOT NULL DEFAULT 0 CHECK (last_position_ms >= 0),
  last_observed_at timestamptz,
  PRIMARY KEY (user_id, source_id, remote_track_id)
);

CREATE INDEX user_track_stats_recent
  ON user_track_stats (user_id, last_played_at DESC NULLS LAST);
CREATE INDEX user_track_stats_most_listened
  ON user_track_stats (user_id, listened_ms DESC, play_starts DESC);

CREATE TABLE user_favorites (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_id uuid NOT NULL REFERENCES music_sources(id) ON DELETE CASCADE,
  entity_type text NOT NULL CHECK (entity_type IN ('track', 'album', 'artist', 'playlist')),
  remote_entity_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, source_id, entity_type, remote_entity_id)
);

CREATE INDEX user_favorites_user_type_time
  ON user_favorites (user_id, entity_type, created_at DESC);

CREATE TABLE lyrics_cache (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id uuid NOT NULL REFERENCES music_sources(id) ON DELETE CASCADE,
  remote_track_id text NOT NULL,
  provider text NOT NULL,
  provider_item_id text,
  lookup_fingerprint text NOT NULL,
  display_artist text,
  display_title text,
  language text,
  synced boolean NOT NULL DEFAULT false,
  instrumental boolean NOT NULL DEFAULT false,
  lines jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL CHECK (status IN ('found', 'not_found')),
  fetched_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  UNIQUE (source_id, remote_track_id, provider, lookup_fingerprint)
);

CREATE INDEX lyrics_cache_expiry ON lyrics_cache (expires_at);

ALTER TABLE queue_items
  ADD COLUMN context_type text,
  ADD COLUMN context_ref text;

ALTER TABLE playback_sessions
  ADD COLUMN repeat_mode text NOT NULL DEFAULT 'none'
    CHECK (repeat_mode IN ('none', 'all', 'one')),
  ADD COLUMN shuffle_enabled boolean NOT NULL DEFAULT false;
