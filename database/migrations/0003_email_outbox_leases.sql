ALTER TABLE email_outbox
  ADD COLUMN lock_id uuid,
  ADD COLUMN locked_at timestamptz;

CREATE INDEX email_outbox_claimable
  ON email_outbox (available_at, id)
  WHERE sent_at IS NULL AND failed_at IS NULL;
