CREATE TABLE music_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  adapter_type text NOT NULL,
  base_url text NOT NULL,
  credential_ciphertext bytea NOT NULL,
  encryption_key_version integer NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  capabilities jsonb NOT NULL DEFAULT '[]'::jsonb,
  server_version text,
  last_checked_at timestamptz,
  last_synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX music_sources_one_enabled
  ON music_sources ((enabled))
  WHERE enabled;

CREATE TABLE playback_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  status text NOT NULL DEFAULT 'stopped' CHECK (status IN ('playing', 'paused', 'stopped')),
  current_queue_item_id uuid,
  position_ms integer NOT NULL DEFAULT 0 CHECK (position_ms >= 0),
  position_observed_at timestamptz NOT NULL DEFAULT now(),
  active_device_id uuid,
  lease_epoch bigint NOT NULL DEFAULT 0 CHECK (lease_epoch >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE queue_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  playback_session_id uuid NOT NULL REFERENCES playback_sessions(id) ON DELETE CASCADE,
  source_id uuid NOT NULL REFERENCES music_sources(id),
  remote_track_id text NOT NULL,
  ordinal bigint NOT NULL,
  origin text NOT NULL,
  added_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz,
  UNIQUE (playback_session_id, ordinal)
);

ALTER TABLE playback_sessions
  ADD CONSTRAINT playback_sessions_current_item_fk
  FOREIGN KEY (current_queue_item_id) REFERENCES queue_items(id) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE devices (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  device_type text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  UNIQUE (user_id, id)
);

ALTER TABLE playback_sessions
  ADD CONSTRAINT playback_sessions_active_device_fk
  FOREIGN KEY (active_device_id) REFERENCES devices(id) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE playback_checkpoints (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  playback_session_id uuid NOT NULL REFERENCES playback_sessions(id) ON DELETE CASCADE,
  queue_item_id uuid REFERENCES queue_items(id) ON DELETE SET NULL,
  revision bigint NOT NULL,
  position_ms integer NOT NULL CHECK (position_ms >= 0),
  status text NOT NULL CHECK (status IN ('playing', 'paused', 'stopped')),
  device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
  lease_epoch bigint NOT NULL,
  observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX playback_checkpoints_latest
  ON playback_checkpoints (playback_session_id, revision DESC, created_at DESC);

CREATE TABLE playback_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  playback_session_id uuid NOT NULL REFERENCES playback_sessions(id) ON DELETE CASCADE,
  device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
  queue_item_id uuid REFERENCES queue_items(id) ON DELETE SET NULL,
  event_type text NOT NULL,
  occurred_at timestamptz NOT NULL,
  position_ms integer CHECK (position_ms >= 0),
  command_id uuid,
  lease_epoch bigint,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (user_id, command_id)
);

CREATE INDEX playback_events_user_time
  ON playback_events (user_id, occurred_at DESC);
