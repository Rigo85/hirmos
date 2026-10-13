-- Run only against an isolated restored copy, before starting Hirmos.
-- Transaction, database identity and absence of other clients are checked by prepare-restored.mjs.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL search_path = public, pg_catalog;

UPDATE auth_sessions SET revoked_at = now() WHERE revoked_at IS NULL;
UPDATE account_invitations SET revoked_at = now()
 WHERE accepted_at IS NULL AND revoked_at IS NULL;
UPDATE password_recovery_tokens SET consumed_at = now() WHERE consumed_at IS NULL;
UPDATE email_outbox SET failed_at = now(), last_error_code = 'RESTORE_CANCELLED',
 lock_id = NULL, locked_at = NULL WHERE sent_at IS NULL AND failed_at IS NULL;

-- Keep queue, selected track and confirmed position. No restored lease may emit audio.
UPDATE playback_sessions SET active_device_id = NULL, lease_expires_at = NULL,
 lease_epoch = lease_epoch + 1, revision = revision + 1,
 status = CASE WHEN current_queue_item_id IS NULL THEN 'stopped' ELSE 'paused' END,
 render_phase = 'paused', playback_attempt = 0, failure_state = '{}'::jsonb,
 queue_undo = NULL, position_observed_at = now(), updated_at = now();

-- Receipts and statistics MUST remain: deleting them would permit duplicate delivery.
-- The activity outbox contains committed statistical events, not executable commands.
UPDATE background_jobs SET status = 'pending', lease_owner = NULL,
 lease_expires_at = NULL, available_at = now(), updated_at = now(),
 last_error_code = 'RESTORE_INTERRUPTED' WHERE status = 'running';
UPDATE catalog_sync_runs SET status = 'failed', completed_at = now(), error_code = 'RESTORE_INTERRUPTED'
 WHERE status = 'running';
INSERT INTO security_events(event_type, metadata)
 VALUES ('system.restore_prepared', '{"sessionsRevoked":true,"pendingMailCancelled":true}'::jsonb);
