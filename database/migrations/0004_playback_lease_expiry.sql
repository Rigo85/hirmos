ALTER TABLE playback_sessions
  ADD COLUMN lease_expires_at timestamptz;

ALTER TABLE playback_sessions
  ADD CONSTRAINT playback_sessions_lease_pair
  CHECK (
    (active_device_id IS NULL AND lease_expires_at IS NULL)
    OR (active_device_id IS NOT NULL AND lease_expires_at IS NOT NULL)
  );
