-- Delivery receipts are separate from the online playback session/outbox.
CREATE TABLE offline_listen_executions (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  source_id uuid NOT NULL REFERENCES music_sources(id) ON DELETE CASCADE,
  remote_track_id text NOT NULL,
  started_at timestamptz NOT NULL,
  PRIMARY KEY (user_id, id)
);
CREATE TABLE offline_listen_receipts (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  execution_id uuid NOT NULL,
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, id),
  FOREIGN KEY (user_id, execution_id) REFERENCES offline_listen_executions(user_id,id) ON DELETE CASCADE
);
CREATE INDEX offline_listen_receipts_execution ON offline_listen_receipts(user_id, execution_id);
