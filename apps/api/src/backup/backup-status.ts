import type { BackupStatusResponse } from '@hirmos/contracts';
import type { Database } from '../db/database.js';

export async function readBackupStatus(db: Pick<Database, 'query'>): Promise<BackupStatusResponse> {
  // Inspect the exact job lock, without acquiring it or disturbing the worker.
  const { rows } = await db.query(`SELECT b.*, clock_timestamp() AS checked_at,
    EXISTS (SELECT 1 FROM pg_locks l WHERE l.locktype='advisory' AND l.granted
      AND l.pid=b.owner_pid AND l.database=(SELECT oid FROM pg_database WHERE datname=current_database())
      AND l.classid=((hashtextextended('hirmos:backup-job',0) >> 32) & 4294967295)::oid
      AND l.objid=(hashtextextended('hirmos:backup-job',0) & 4294967295)::oid
      AND l.objsubid=1) AS active
    FROM (SELECT true AS singleton) seed LEFT JOIN backup_status b USING(singleton)`);
  const row = rows[0]!;
  const checkedAt = new Date(row.checked_at);
  const snapshot = row.last_snapshot_at ? new Date(row.last_snapshot_at) : null;
  const overdue = !snapshot || checkedAt.getTime() - snapshot.getTime() > 36 * 3600000;
  return {
    checkedAt: checkedAt.toISOString(), overdue, thresholdHours: 36,
    lastAttempt: row.run_id ? {
      startedAt: new Date(row.started_at).toISOString(),
      finishedAt: row.finished_at ? new Date(row.finished_at).toISOString() : null,
      outcome: row.outcome === 'running' && !row.active ? 'interrupted' : row.outcome,
      phase: row.phase,
    } : null,
    lastSuccess: row.last_success_at && snapshot ? {
      verifiedAt: new Date(row.last_success_at).toISOString(), snapshotAt: snapshot.toISOString(),
      bytes: Number(row.last_bytes), durationMs: Number(row.last_duration_ms),
    } : null,
  };
}
