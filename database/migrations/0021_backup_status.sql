-- Bounded operational receipt, not a second inventory of files or a job queue.
CREATE TABLE backup_status (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  run_id uuid NOT NULL,
  owner_pid integer NOT NULL,
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  outcome text NOT NULL CHECK (outcome IN ('running', 'succeeded', 'failed', 'warning')),
  phase text NOT NULL CHECK (phase IN ('destination', 'snapshot', 'files', 'verification', 'retention', 'complete')),
  last_success_at timestamptz,
  last_snapshot_at timestamptz,
  last_bytes bigint CHECK (last_bytes >= 0),
  last_duration_ms bigint CHECK (last_duration_ms >= 0)
);
