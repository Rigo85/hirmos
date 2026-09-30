-- Additive foundation for queue editing and repeat; no playlists or repeat UI yet.
ALTER TABLE playback_sessions
  ADD COLUMN queue_revision bigint NOT NULL DEFAULT 0 CHECK (queue_revision >= 0),
  ADD COLUMN playback_instance_id uuid;

UPDATE playback_sessions SET playback_instance_id = gen_random_uuid()
 WHERE current_queue_item_id IS NOT NULL;

CREATE TABLE playback_command_receipts (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  command_id uuid NOT NULL,
  request_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, command_id)
);

-- Raw, compact transitions committed together with the command. The projection
-- acknowledges each row in the same transaction as its statistics updates.
CREATE TABLE playback_activity_outbox (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  command_id uuid NOT NULL,
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  processed_at timestamptz,
  UNIQUE (user_id, command_id)
);
CREATE INDEX playback_activity_pending ON playback_activity_outbox (id)
  WHERE processed_at IS NULL;

-- Per-execution projection state; pause/seek/transfer do not create a new run.
CREATE TABLE playback_activity_instances (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  started boolean NOT NULL DEFAULT false,
  closed boolean NOT NULL DEFAULT false
);

-- Preserve an already-recorded start across upgrade; do not replay historical
-- commands or count the currently selected queue entry again on first progress.
INSERT INTO playback_activity_instances (id, user_id, started, closed)
SELECT s.playback_instance_id, s.user_id,
       EXISTS (SELECT 1 FROM listen_events e
               WHERE e.user_id = s.user_id AND e.queue_item_id = s.current_queue_item_id
                 AND e.event_type = 'started'),
       s.status = 'stopped'
  FROM playback_sessions s WHERE s.playback_instance_id IS NOT NULL;
