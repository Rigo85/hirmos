ALTER TABLE playback_sessions
  ADD COLUMN playback_attempt integer NOT NULL DEFAULT 0 CHECK (playback_attempt >= 0),
  ADD COLUMN render_phase text NOT NULL DEFAULT 'unknown' CHECK (render_phase IN ('unknown','loading','buffering','playing','paused','error','blocked')),
  ADD COLUMN failure_state jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE playback_failures (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  playback_instance_id uuid NOT NULL,
  attempt integer NOT NULL CHECK (attempt >= 0),
  track_ref text NOT NULL,
  code text NOT NULL CHECK (code IN ('network','timeout','decode','unsupported','not_found','unknown','autoplay','authentication','service_unavailable','offline')),
  phase text NOT NULL CHECK (phase IN ('metadata','start','stream')),
  position_ms integer NOT NULL CHECK (position_ms >= 0),
  elapsed_ms integer NOT NULL CHECK (elapsed_ms >= 0 AND elapsed_ms <= 120000),
  outcome text NOT NULL CHECK (outcome IN ('advanced','blocked','limit','end','paused')),
  occurred_at timestamptz NOT NULL DEFAULT statement_timestamp()
);
CREATE INDEX playback_failures_user_time ON playback_failures (user_id, occurred_at DESC);
ALTER TABLE playback_activity_instances ADD COLUMN technical_interruption boolean NOT NULL DEFAULT false;
