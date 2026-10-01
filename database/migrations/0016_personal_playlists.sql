CREATE TABLE playlists (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 2000),
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX playlists_owner ON playlists(user_id, updated_at DESC) WHERE deleted_at IS NULL;
CREATE TABLE playlist_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  playlist_id uuid NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  source_id uuid NOT NULL REFERENCES music_sources(id),
  remote_track_id text NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  metadata jsonb NOT NULL,
  UNIQUE (playlist_id, ordinal) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE playlist_command_receipts (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  command_id uuid NOT NULL,
  request_hash text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, command_id)
);
