import type { PlaybackSnapshot } from '@hirmos/contracts';
import type { FastifyBaseLogger } from 'fastify';
import type { Database } from '../db/database.js';
import { ActivityRepository } from '../activity/activity-repository.js';

interface Transition {
  name: string;
  deviceId: string;
  action?: string;
  reason?: string;
  reportedPositionMs?: number;
  before: PlaybackSnapshot;
  after: PlaybackSnapshot;
}

export class PlaybackActivityProjector {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private active: Promise<void> | null = null;
  private stopping = true;
  private failures = 0;

  public constructor(private readonly db: Database,
    private readonly logger: Pick<FastifyBaseLogger, 'info' | 'warn'>) {}

  public start(): void {
    if (!this.stopping) return;
    this.stopping = false;
    this.schedule(100);
  }

  public async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.active;
  }

  private schedule(delay: number): void {
    if (this.stopping) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.active = this.tick().finally(() => { this.active = null; });
    }, delay);
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    try {
      const count = await this.runBatch();
      this.failures = 0;
      if (count) this.logger.info({ playbackProjection: { processed: count } }, 'Listening activity projected');
      this.schedule(count === 50 ? 100 : 2_000);
    } catch {
      this.failures += 1;
      const retryMs = Math.min(60_000, 1_000 * 2 ** Math.min(6, this.failures)) + Math.round(Math.random() * 1_000);
      // Do not log SQL parameters or the raw musical/user payload.
      this.logger.warn({ playbackProjection: { outcome: 'retry', failures: this.failures, retryMs } },
        'Listening projection failed; durable events retained');
      this.schedule(retryMs);
    }
  }

  public async runBatch(): Promise<number> {
    if (!this.db.transaction) throw new Error('Projection requires a transaction');
    return this.db.transaction(async connection => {
      const db: Database = { ...connection, close: async () => undefined };
      // One ordered projection, even when two workers start. No command path
      // takes this lock; a slow projection cannot hold a playback session lock.
      const lock = await db.query<{ locked: boolean }>(
        `SELECT pg_try_advisory_xact_lock(hashtext('hirmos-playback-activity')) AS locked`);
      if (!lock.rows[0]?.locked) return 0;
      const rows = await db.query<{
        id: string; user_id: string; payload: Transition; occurred_at: Date;
      }>(`SELECT id::text, user_id, payload, occurred_at FROM playback_activity_outbox
          WHERE processed_at IS NULL ORDER BY id LIMIT 50 FOR UPDATE`);
      for (const row of rows.rows) {
        await project(db, row.user_id, row.payload, row.occurred_at);
        await db.query('UPDATE playback_activity_outbox SET processed_at = now() WHERE id = $1', [row.id]);
      }
      return rows.rowCount ?? 0;
    });
  }
}

async function project(db: Database, userId: string, fact: Transition, at: Date): Promise<void> {
  const activity = new ActivityRepository(db, at);
  const { before, after } = fact;
  const instance = before.playbackInstanceId;
  const current = after.playbackInstanceId;
  const ended = fact.name === 'control' && fact.action === 'next' && fact.reason === 'ended';
  const event = (type: 'started' | 'completed' | 'skipped' | 'paused' | 'resumed' | 'seeked', snapshot: PlaybackSnapshot) =>
    activity.recordEvent({ userId, deviceId: fact.deviceId, snapshot, type });
  for (const id of new Set([instance, current].filter(Boolean))) {
    await db.query(`INSERT INTO playback_activity_instances (id, user_id)
      VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`, [id, userId]);
  }

  // Only progress on the same execution is evidence of playback. Selection is
  // an intention, and seeking must never count as listened time or a new start.
  const failed = fact.name === 'failure';
  const progress = (ended || failed) && fact.reportedPositionMs !== undefined
    ? { ...before, positionMs: fact.reportedPositionMs } : after;
  if ((fact.name === 'update' || ended || failed) && instance && instance === progress.playbackInstanceId
    && progress.positionMs > before.positionMs
    && (before.status === 'playing' || (failed && before.status === 'paused'))) {
    const started = await db.query(`UPDATE playback_activity_instances SET started = true
      WHERE id = $1 AND user_id = $2 AND NOT started AND NOT closed RETURNING id`, [instance, userId]);
    if (started.rowCount) await event('started', progress);
    const open = await db.query('SELECT id FROM playback_activity_instances WHERE id = $1 AND user_id = $2 AND NOT closed', [instance, userId]);
    // A pause may win the transaction race before the owner reports the
    // audio failure. Preserve the final positive delta already heard, without
    // changing the paused intent or counting any synthetic elapsed position.
    if (open.rowCount) await activity.recordProgress({ userId,
      before: failed && before.status === 'paused' ? { ...before, status: 'playing' } : before,
      after: progress });
    if (!failed) await db.query(`UPDATE playback_activity_instances SET technical_interruption=false
      WHERE id=$1 AND user_id=$2`, [instance,userId]);
  }
  if (failed && instance) await db.query(`UPDATE playback_activity_instances SET technical_interruption=true
    WHERE id=$1 AND user_id=$2`, [instance,userId]);

  const left = instance && (instance !== current || (after.status === 'stopped' && before.status !== 'stopped'));
  if (instance && (ended || left)) {
    const closed = await db.query<{ started: boolean; technical_interruption: boolean }>(`UPDATE playback_activity_instances SET closed = true
      WHERE id = $1 AND user_id = $2 AND NOT closed RETURNING started,technical_interruption`, [instance, userId]);
    if (closed.rows[0]?.started && !closed.rows[0].technical_interruption) {
      await event(ended ? 'completed' : 'skipped', ended ? progress : before);
    }
  } else if (instance && fact.name === 'control' && ['play', 'pause', 'seek'].includes(fact.action ?? '')) {
    const started = await db.query('SELECT id FROM playback_activity_instances WHERE id = $1 AND user_id = $2 AND started AND NOT closed', [instance, userId]);
    if (started.rowCount) await event(fact.action === 'play' ? 'resumed' : fact.action === 'pause' ? 'paused' : 'seeked', after);
  }
}
