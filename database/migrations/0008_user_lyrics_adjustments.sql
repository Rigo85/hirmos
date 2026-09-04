CREATE TABLE user_lyrics_adjustments (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_id uuid NOT NULL REFERENCES music_sources(id) ON DELETE CASCADE,
  remote_track_id text NOT NULL,
  adjustment_ms integer NOT NULL DEFAULT 0
    CHECK (adjustment_ms BETWEEN -30000 AND 30000),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, source_id, remote_track_id)
);

CREATE INDEX user_lyrics_adjustments_user_time
  ON user_lyrics_adjustments (user_id, updated_at DESC);
