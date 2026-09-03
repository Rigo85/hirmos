import type {
  PlaybackCommandResult,
  PlaybackQueueItem,
  PlaybackSnapshot,
} from '@hirmos/contracts';
import type { Database } from '../db/database.js';
import { encodeTrackReference } from '../music-source/track-reference.js';

const LEASE_SECONDS = 30;

interface SnapshotRow {
  id: string;
  revision: string;
  status: PlaybackSnapshot['status'];
  current_queue_item_id: string | null;
  position_ms: number;
  position_observed_at: Date;
  active_device_id: string | null;
  lease_epoch: string;
  lease_expires_at: Date | null;
  source_id: string | null;
  remote_track_id: string | null;
}

interface QueueRow {
  id: string;
  source_id: string;
  remote_track_id: string;
  ordinal: string;
  origin: string;
}

export class PlaybackRepository {
  public constructor(private readonly db: Database) {}

  public async registerDevice(input: {
    userId: string;
    deviceId: string;
    name: string;
    type: string;
  }): Promise<boolean> {
    const result = await this.db.query<{ id: string }>(
      `INSERT INTO devices (id, user_id, name, device_type)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE
         SET name = EXCLUDED.name, device_type = EXCLUDED.device_type,
             last_seen_at = now()
         WHERE devices.user_id = EXCLUDED.user_id
           AND devices.revoked_at IS NULL
       RETURNING id`,
      [input.deviceId, input.userId, input.name, input.type],
    );
    return Boolean(result.rows[0]);
  }

  public async snapshot(userId: string): Promise<PlaybackSnapshot> {
    await this.ensureSession(userId);
    await this.db.query(
      `UPDATE playback_sessions
          SET active_device_id = NULL,
              lease_expires_at = NULL,
              status = CASE WHEN status = 'playing' THEN 'paused' ELSE status END,
              revision = revision + 1,
              updated_at = now()
        WHERE user_id = $1
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at <= now()`,
      [userId],
    );
    const [sessionResult, queueResult] = await Promise.all([
      this.db.query<SnapshotRow>(
        `SELECT s.id, s.revision::text, s.status, s.current_queue_item_id,
                s.position_ms, s.position_observed_at, s.active_device_id,
                s.lease_epoch::text, s.lease_expires_at,
                q.source_id, q.remote_track_id
           FROM playback_sessions s
           LEFT JOIN queue_items q ON q.id = s.current_queue_item_id
          WHERE s.user_id = $1`,
        [userId],
      ),
      this.db.query<QueueRow>(
        `SELECT q.id, q.source_id, q.remote_track_id, q.ordinal::text, q.origin
           FROM queue_items q
           JOIN playback_sessions s ON s.id = q.playback_session_id
          WHERE s.user_id = $1 AND q.removed_at IS NULL
          ORDER BY q.ordinal`,
        [userId],
      ),
    ]);
    const row = sessionResult.rows[0];
    if (!row) throw new Error('Failed to load playback session');
    return mapSnapshot(row, queueResult.rows);
  }

  public async claim(input: {
    userId: string;
    deviceId: string;
    commandId: string;
    expectedRevision: number;
  }): Promise<PlaybackCommandResult> {
    await this.ensureSession(input.userId);
    const result = await this.db.query(
      `WITH candidate AS (
         SELECT s.*
           FROM playback_sessions s
           JOIN devices d ON d.id = $2 AND d.user_id = $1 AND d.revoked_at IS NULL
          WHERE s.user_id = $1 AND s.revision = $4
          FOR UPDATE OF s
       ), accepted AS (
         INSERT INTO playback_events
           (user_id, playback_session_id, device_id, event_type, occurred_at,
            command_id, payload)
         SELECT $1, candidate.id, $2, 'lease.claimed', now(), $3,
                jsonb_build_object('expectedRevision', $4::bigint)
           FROM candidate
         ON CONFLICT (user_id, command_id) DO NOTHING
         RETURNING playback_session_id
       ), updated AS (
         UPDATE playback_sessions s
            SET active_device_id = $2,
                lease_epoch = lease_epoch + 1,
                lease_expires_at = now() + interval '${LEASE_SECONDS} seconds',
                revision = revision + 1,
                updated_at = now()
           FROM accepted
          WHERE s.id = accepted.playback_session_id
         RETURNING s.*
       )
       INSERT INTO playback_checkpoints
         (playback_session_id, queue_item_id, revision, position_ms, status,
          device_id, lease_epoch, observed_at)
       SELECT id, current_queue_item_id, revision, position_ms, status,
              $2, lease_epoch, position_observed_at
         FROM updated
       RETURNING id`,
      [input.userId, input.deviceId, input.commandId, input.expectedRevision],
    );
    return this.commandResult(input.userId, input.commandId, Boolean(result.rowCount));
  }

  public async select(input: {
    userId: string;
    deviceId: string;
    commandId: string;
    expectedRevision: number;
    sourceId: string;
    remoteTrackId: string;
  }): Promise<PlaybackCommandResult> {
    await this.ensureSession(input.userId);
    const result = await this.db.query(
      `WITH candidate AS (
         SELECT s.id
           FROM playback_sessions s
           JOIN devices d ON d.id = $2 AND d.user_id = $1 AND d.revoked_at IS NULL
           JOIN music_sources m ON m.id = $5 AND m.enabled
          WHERE s.user_id = $1 AND s.revision = $4
          FOR UPDATE OF s
       ), accepted AS (
         INSERT INTO playback_events
           (user_id, playback_session_id, device_id, event_type, occurred_at,
            command_id, payload)
         SELECT $1, candidate.id, $2, 'track.selected', now(), $3,
                jsonb_build_object('expectedRevision', $4::bigint)
           FROM candidate
         ON CONFLICT (user_id, command_id) DO NOTHING
         RETURNING playback_session_id
       ), item AS (
         INSERT INTO queue_items
           (playback_session_id, source_id, remote_track_id, ordinal, origin)
         SELECT a.playback_session_id, $5, $6,
                COALESCE((SELECT max(q.ordinal) + 1 FROM queue_items q
                           WHERE q.playback_session_id = a.playback_session_id), 0),
                'user'
           FROM accepted a
         RETURNING id, playback_session_id
       ), updated AS (
         UPDATE playback_sessions s
            SET current_queue_item_id = item.id,
                status = 'playing', position_ms = 0, position_observed_at = now(),
                active_device_id = $2, lease_epoch = lease_epoch + 1,
                lease_expires_at = now() + interval '${LEASE_SECONDS} seconds',
                revision = revision + 1, updated_at = now()
           FROM item
          WHERE s.id = item.playback_session_id
         RETURNING s.*
       )
       INSERT INTO playback_checkpoints
         (playback_session_id, queue_item_id, revision, position_ms, status,
          device_id, lease_epoch, observed_at)
       SELECT id, current_queue_item_id, revision, position_ms, status,
              $2, lease_epoch, position_observed_at
         FROM updated
       RETURNING id`,
      [input.userId, input.deviceId, input.commandId, input.expectedRevision,
       input.sourceId, input.remoteTrackId],
    );
    return this.commandResult(input.userId, input.commandId, Boolean(result.rowCount));
  }

  public async update(input: {
    userId: string;
    deviceId: string;
    commandId: string;
    expectedRevision: number;
    leaseEpoch: number;
    status: PlaybackSnapshot['status'];
    positionMs: number;
  }): Promise<PlaybackCommandResult> {
    await this.ensureSession(input.userId);
    const result = await this.db.query(
      `WITH candidate AS (
         SELECT s.id
           FROM playback_sessions s
          WHERE s.user_id = $1 AND s.revision = $4
            AND s.active_device_id = $2 AND s.lease_epoch = $5
            AND s.lease_expires_at > now()
          FOR UPDATE OF s
       ), accepted AS (
         INSERT INTO playback_events
           (user_id, playback_session_id, device_id, event_type, occurred_at,
            position_ms, command_id, lease_epoch)
         SELECT $1, candidate.id, $2, 'playback.updated', now(), $6, $3, $5
           FROM candidate
         ON CONFLICT (user_id, command_id) DO NOTHING
         RETURNING playback_session_id
       ), touched AS (
         UPDATE devices SET last_seen_at = now()
          WHERE id = $2 AND user_id = $1 AND EXISTS (SELECT 1 FROM accepted)
       ), updated AS (
         UPDATE playback_sessions s
            SET status = $7, position_ms = $6, position_observed_at = now(),
                lease_expires_at = now() + interval '${LEASE_SECONDS} seconds',
                revision = revision + 1, updated_at = now()
           FROM accepted
          WHERE s.id = accepted.playback_session_id
         RETURNING s.*
       )
       INSERT INTO playback_checkpoints
         (playback_session_id, queue_item_id, revision, position_ms, status,
          device_id, lease_epoch, observed_at)
       SELECT id, current_queue_item_id, revision, position_ms, status,
              $2, lease_epoch, position_observed_at
         FROM updated
       RETURNING id`,
      [input.userId, input.deviceId, input.commandId, input.expectedRevision,
       input.leaseEpoch, input.positionMs, input.status],
    );
    return this.commandResult(input.userId, input.commandId, Boolean(result.rowCount));
  }

  public async selectContext(input: {
    userId: string;
    deviceId: string;
    commandId: string;
    expectedRevision: number;
    sourceId: string;
    remoteTrackIds: string[];
    selectedIndex: number;
    contextType: string;
    contextRef: string | null;
  }): Promise<PlaybackCommandResult> {
    await this.ensureSession(input.userId);
    const result = await this.db.query(
      `WITH candidate AS (
         SELECT s.id
           FROM playback_sessions s
           JOIN devices d ON d.id = $2 AND d.user_id = $1 AND d.revoked_at IS NULL
           JOIN music_sources m ON m.id = $5 AND m.enabled
          WHERE s.user_id = $1 AND s.revision = $4
          FOR UPDATE OF s
       ), accepted AS (
         INSERT INTO playback_events
           (user_id, playback_session_id, device_id, event_type, occurred_at,
            command_id, payload)
         SELECT $1, candidate.id, $2, 'context.selected', now(), $3,
                jsonb_build_object('expectedRevision', $4::bigint, 'contextType', $8::text,
                                   'contextRef', $9::text, 'trackCount', cardinality($6::text[]))
           FROM candidate
         ON CONFLICT (user_id, command_id) DO NOTHING
         RETURNING playback_session_id
       ), removed AS (
         UPDATE queue_items SET removed_at = now()
          WHERE playback_session_id IN (SELECT playback_session_id FROM accepted)
            AND removed_at IS NULL
       ), inserted AS (
         INSERT INTO queue_items
           (playback_session_id, source_id, remote_track_id, ordinal, origin,
            context_type, context_ref)
         SELECT accepted.playback_session_id, $5, songs.remote_track_id,
                COALESCE((SELECT max(q.ordinal) + 1
                            FROM queue_items q
                           WHERE q.playback_session_id = accepted.playback_session_id), 0)
                  + songs.ordinality - 1,
                'context', $8, $9
           FROM accepted
           CROSS JOIN unnest($6::text[]) WITH ORDINALITY songs(remote_track_id, ordinality)
         RETURNING id, playback_session_id, ordinal
       ), target AS (
         SELECT id, playback_session_id
           FROM inserted
          ORDER BY ordinal
          OFFSET $7 LIMIT 1
       ), updated AS (
         UPDATE playback_sessions s
            SET current_queue_item_id = target.id,
                status = 'playing', position_ms = 0, position_observed_at = now(),
                active_device_id = $2, lease_epoch = lease_epoch + 1,
                lease_expires_at = now() + interval '${LEASE_SECONDS} seconds',
                revision = revision + 1, updated_at = now()
           FROM target WHERE s.id = target.playback_session_id
         RETURNING s.*
       )
       INSERT INTO playback_checkpoints
         (playback_session_id, queue_item_id, revision, position_ms, status,
          device_id, lease_epoch, observed_at)
       SELECT id, current_queue_item_id, revision, position_ms, status,
              $2, lease_epoch, position_observed_at FROM updated
       RETURNING id`,
      [input.userId, input.deviceId, input.commandId, input.expectedRevision,
       input.sourceId, input.remoteTrackIds, input.selectedIndex, input.contextType,
       input.contextRef],
    );
    return this.commandResult(input.userId, input.commandId, Boolean(result.rowCount));
  }

  public async control(input: {
    userId: string;
    deviceId: string;
    commandId: string;
    expectedRevision: number;
    action: 'play' | 'pause' | 'next' | 'previous' | 'seek';
    positionMs?: number;
  }): Promise<PlaybackCommandResult> {
    if (input.action === 'next' || input.action === 'previous') {
      return this.move(input, input.action);
    }
    await this.ensureSession(input.userId);
    const status = input.action === 'play' ? 'playing'
      : input.action === 'pause' ? 'paused' : null;
    const result = await this.db.query(
      `WITH candidate AS (
         SELECT s.id
          FROM playback_sessions s
          WHERE s.user_id = $1 AND s.revision = $4
            AND s.current_queue_item_id IS NOT NULL
            AND s.active_device_id IS NOT NULL
            AND s.lease_expires_at > now()
          FOR UPDATE OF s
       ), accepted AS (
         INSERT INTO playback_events
           (user_id, playback_session_id, device_id, event_type, occurred_at,
            position_ms, command_id, payload)
         SELECT $1, candidate.id, $2, 'playback.controlled', now(), $6, $3,
                jsonb_build_object('action', $5::text)
           FROM candidate
         ON CONFLICT (user_id, command_id) DO NOTHING
         RETURNING playback_session_id
       ), updated AS (
         UPDATE playback_sessions s
            SET status = COALESCE($7, s.status),
                position_ms = CASE WHEN $5 = 'seek' THEN $6 ELSE s.position_ms END,
                position_observed_at = now(), revision = revision + 1,
                updated_at = now()
           FROM accepted
          WHERE s.id = accepted.playback_session_id
         RETURNING s.*
       )
       INSERT INTO playback_checkpoints
         (playback_session_id, queue_item_id, revision, position_ms, status,
          device_id, lease_epoch, observed_at)
       SELECT id, current_queue_item_id, revision, position_ms, status,
              $2, lease_epoch, position_observed_at
         FROM updated
       RETURNING id`,
      [input.userId, input.deviceId, input.commandId, input.expectedRevision,
       input.action, input.positionMs ?? 0, status],
    );
    return this.commandResult(input.userId, input.commandId, Boolean(result.rowCount));
  }

  public async removeQueueItem(input: {
    userId: string;
    deviceId: string;
    commandId: string;
    expectedRevision: number;
    queueItemId: string;
  }): Promise<PlaybackCommandResult> {
    await this.ensureSession(input.userId);
    const result = await this.db.query(
      `WITH candidate AS (
         SELECT s.*, q.ordinal AS removed_ordinal
           FROM playback_sessions s
           JOIN queue_items q ON q.id = $5 AND q.playback_session_id = s.id
                              AND q.removed_at IS NULL
          WHERE s.user_id = $1 AND s.revision = $4
          FOR UPDATE OF s, q
       ), accepted AS (
         INSERT INTO playback_events
           (user_id, playback_session_id, device_id, queue_item_id, event_type,
            occurred_at, command_id)
         SELECT $1, id, $2, $5, 'queue.removed', now(), $3 FROM candidate
         ON CONFLICT (user_id, command_id) DO NOTHING
         RETURNING playback_session_id
       ), removed AS (
         UPDATE queue_items SET removed_at = now()
          WHERE id = $5 AND EXISTS (SELECT 1 FROM accepted)
         RETURNING playback_session_id
       ), replacement AS (
         SELECT CASE WHEN c.current_queue_item_id = $5 THEN
           COALESCE(
             (SELECT q.id FROM queue_items q WHERE q.playback_session_id = c.id
                AND q.removed_at IS NULL AND q.ordinal > c.removed_ordinal
                ORDER BY q.ordinal LIMIT 1),
             (SELECT q.id FROM queue_items q WHERE q.playback_session_id = c.id
                AND q.removed_at IS NULL AND q.ordinal < c.removed_ordinal
                ORDER BY q.ordinal DESC LIMIT 1)
           ) ELSE c.current_queue_item_id END AS item_id,
           c.id, c.current_queue_item_id = $5 AS removed_current
           FROM candidate c WHERE EXISTS (SELECT 1 FROM accepted)
       ), updated AS (
         UPDATE playback_sessions s
            SET current_queue_item_id = replacement.item_id,
                position_ms = CASE WHEN replacement.removed_current THEN 0 ELSE s.position_ms END,
                position_observed_at = now(),
                status = CASE WHEN replacement.item_id IS NULL THEN 'stopped' ELSE s.status END,
                revision = revision + 1, updated_at = now()
           FROM replacement WHERE s.id = replacement.id
         RETURNING s.*
       )
       INSERT INTO playback_checkpoints
         (playback_session_id, queue_item_id, revision, position_ms, status,
          device_id, lease_epoch, observed_at)
       SELECT id, current_queue_item_id, revision, position_ms, status,
              $2, lease_epoch, position_observed_at FROM updated
       RETURNING id`,
      [input.userId, input.deviceId, input.commandId, input.expectedRevision,
       input.queueItemId],
    );
    return this.commandResult(input.userId, input.commandId, Boolean(result.rowCount));
  }

  private async move(
    input: Parameters<PlaybackRepository['control']>[0],
    direction: 'next' | 'previous',
  ): Promise<PlaybackCommandResult> {
    await this.ensureSession(input.userId);
    const operator = direction === 'next' ? '>' : '<';
    const order = direction === 'next' ? 'ASC' : 'DESC';
    const result = await this.db.query(
      `WITH candidate AS (
         SELECT s.*, current.ordinal AS current_ordinal
           FROM playback_sessions s
          JOIN queue_items current ON current.id = s.current_queue_item_id
          WHERE s.user_id = $1 AND s.revision = $4
            AND s.active_device_id IS NOT NULL
            AND s.lease_expires_at > now()
          FOR UPDATE OF s
       ), target AS (
         SELECT candidate.id AS session_id,
                (SELECT q.id FROM queue_items q
                  WHERE q.playback_session_id = candidate.id
                    AND q.removed_at IS NULL
                    AND q.ordinal ${operator} candidate.current_ordinal
                  ORDER BY q.ordinal ${order} LIMIT 1) AS item_id
           FROM candidate
       ), accepted AS (
         INSERT INTO playback_events
           (user_id, playback_session_id, device_id, event_type, occurred_at,
            command_id, payload)
         SELECT $1, target.session_id, $2, 'playback.controlled', now(), $3,
                jsonb_build_object('action', $5::text)
           FROM target
         ON CONFLICT (user_id, command_id) DO NOTHING
         RETURNING playback_session_id
       ), updated AS (
         UPDATE playback_sessions s
            SET current_queue_item_id = COALESCE(target.item_id, s.current_queue_item_id),
                status = CASE WHEN target.item_id IS NULL THEN 'stopped' ELSE 'playing' END,
                position_ms = 0, position_observed_at = now(),
                revision = revision + 1, updated_at = now()
           FROM target, accepted
          WHERE s.id = target.session_id AND accepted.playback_session_id = s.id
         RETURNING s.*
       )
       INSERT INTO playback_checkpoints
         (playback_session_id, queue_item_id, revision, position_ms, status,
          device_id, lease_epoch, observed_at)
       SELECT id, current_queue_item_id, revision, position_ms, status,
              $2, lease_epoch, position_observed_at FROM updated
       RETURNING id`,
      [input.userId, input.deviceId, input.commandId, input.expectedRevision, direction],
    );
    return this.commandResult(input.userId, input.commandId, Boolean(result.rowCount));
  }

  private async commandResult(
    userId: string,
    commandId: string,
    accepted: boolean,
  ): Promise<PlaybackCommandResult> {
    let status: PlaybackCommandResult['status'] = accepted ? 'accepted' : 'conflict';
    if (!accepted) {
      const existing = await this.db.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM playback_events WHERE user_id = $1 AND command_id = $2
         ) AS exists`,
        [userId, commandId],
      );
      if (existing.rows[0]?.exists) status = 'duplicate';
    }
    return { status, snapshot: await this.snapshot(userId) };
  }

  private async ensureSession(userId: string): Promise<void> {
    await this.db.query(
      `INSERT INTO playback_sessions (user_id) VALUES ($1)
       ON CONFLICT (user_id) DO NOTHING`,
      [userId],
    );
  }
}

function mapSnapshot(row: SnapshotRow, queueRows: QueueRow[]): PlaybackSnapshot {
  const queue: PlaybackQueueItem[] = queueRows.map((item) => ({
    id: item.id,
    trackRef: encodeTrackReference(item.source_id, item.remote_track_id),
    ordinal: Number(item.ordinal),
    origin: item.origin,
  }));
  return {
    sessionId: row.id,
    revision: Number(row.revision),
    status: row.status,
    currentQueueItemId: row.current_queue_item_id,
    currentTrackRef: row.source_id && row.remote_track_id
      ? encodeTrackReference(row.source_id, row.remote_track_id)
      : null,
    positionMs: row.position_ms,
    positionObservedAt: row.position_observed_at.toISOString(),
    activeDeviceId: row.active_device_id,
    leaseEpoch: Number(row.lease_epoch),
    leaseExpiresAt: row.lease_expires_at?.toISOString() ?? null,
    queue,
  };
}
