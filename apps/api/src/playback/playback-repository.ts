import type {
  PlaybackAnchor,
  PlaybackCommandName,
  PlaybackCommandResult,
  PlaybackQueueItem,
  PlaybackSnapshot,
  PlaybackFailure,
  PlaybackFailureNotice,
  PlaybackRenderPhase,
  QueueEditCommand,
  RepeatCommand,
} from '@hirmos/contracts';
import { nextQueueItem, previousQueueItem } from '@hirmos/domain';
import { createHash, randomUUID } from 'node:crypto';
import { uniqueTracks } from '../music-source/unique-tracks.js';
import type { Database } from '../db/database.js';
import { encodeTrackReference } from '../music-source/track-reference.js';
import { editQueue } from './queue-editor.js';

const LEASE_SECONDS = 30;
interface FailureState {
  omitted?: string[]; consecutive?: number; since?: number; healthySince?: number;
  notices?: PlaybackFailureNotice[];
  permissionBudgetMs?: number;
}

interface SnapshotRow {
  id: string;
  revision: string;
  status: PlaybackSnapshot['status'];
  repeat_mode: 'none' | 'all' | 'one';
  current_queue_item_id: string | null;
  position_ms: number;
  position_observed_at: Date;
  active_device_id: string | null;
  lease_epoch: string;
  lease_expires_at: Date | null;
  source_id: string | null;
  remote_track_id: string | null;
  queue_revision: string;
  playback_instance_id: string | null;
  queue_rows: QueueRow[];
  playback_attempt: number;
  render_phase: PlaybackRenderPhase;
  failure_state: FailureState;
  queue_manually_edited: boolean;
  queue_past_count: number;
  queue_undo: { id:string; expiresAt:string; revision:number; current:string|null; instance:string|null } | null;
}

interface QueueRow {
  id: string;
  source_id: string;
  remote_track_id: string;
  ordinal: string;
  origin: string;
  priority: boolean;
  playlist_item_id: string | null;
  context_type: string | null;
  context_ref: string | null;
}

export class PlaybackRepository {
  public constructor(private readonly db: Database, private readonly insideCommand = false) {}

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
             last_seen_at = statement_timestamp()
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
              updated_at = statement_timestamp()
        WHERE user_id = $1
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at <= statement_timestamp()`,
      [userId],
    );
    const sessionResult = await this.db.query<SnapshotRow>(
        `SELECT s.id, s.revision::text, s.status, s.repeat_mode, s.current_queue_item_id,
                s.position_ms, s.position_observed_at, s.active_device_id,
                s.lease_epoch::text, s.lease_expires_at,
                s.queue_revision::text, s.playback_instance_id,
                s.playback_attempt, s.render_phase, s.failure_state,
                s.queue_manually_edited,s.queue_past_count,s.queue_undo,
                q.source_id, q.remote_track_id,
                COALESCE((SELECT jsonb_agg(jsonb_build_object(
                  'id', items.id, 'source_id', items.source_id,
                  'remote_track_id', items.remote_track_id,
                  'ordinal', items.ordinal::text, 'origin', items.origin,
                  'priority',items.priority,'playlist_item_id',items.playlist_item_id,
                  'context_type',items.context_type,'context_ref',items.context_ref
                ) ORDER BY items.ordinal)
                  FROM queue_items items
                 WHERE items.playback_session_id = s.id AND items.removed_at IS NULL
                ), '[]'::jsonb) AS queue_rows
           FROM playback_sessions s
           LEFT JOIN queue_items q ON q.id = s.current_queue_item_id
          WHERE s.user_id = $1`,
        [userId],
      );
    const row = sessionResult.rows[0];
    if (!row) throw new Error('Failed to load playback session');
    return mapSnapshot(row, row.queue_rows);
  }

  public async claim(input: {
    userId: string;
    deviceId: string;
    commandId: string;
    expectedRevision: number;
  }): Promise<PlaybackCommandResult> {
    if (!this.insideCommand) return this.command('claim', input, repo => repo.claim(input));
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
         SELECT $1, candidate.id, $2, 'lease.claimed', statement_timestamp(), $3,
                jsonb_build_object('expectedRevision', $4::bigint)
           FROM candidate
         ON CONFLICT (user_id, command_id) DO NOTHING
         RETURNING playback_session_id
       ), updated AS (
         UPDATE playback_sessions s
            SET active_device_id = $2,
                lease_epoch = lease_epoch + 1,
                lease_expires_at = statement_timestamp() + interval '${LEASE_SECONDS} seconds',
                revision = revision + 1,
                updated_at = statement_timestamp()
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

  public async selectPlaylist(input: {
    userId:string; deviceId:string; commandId:string; expectedRevision:number;
    playlistId:string; playlistRevision:number; itemId:string|null; shuffle:boolean;
    replaceQueueRevision?:number;
  }):Promise<PlaybackCommandResult> {
    if (!this.insideCommand) return this.command('select-playlist',input,repo=>repo.selectPlaylist(input));
    const row=(await this.db.query<{revision:number; items:{id:string;source:string;track:string;available:boolean;unknown:boolean}[]}>(`
      SELECT p.revision,COALESCE((SELECT jsonb_agg(jsonb_build_object('id',i.id,'source',i.source_id,
        'track',i.remote_track_id,'available',s.enabled AND c.remote_track_id IS NOT NULL AND c.missing_since IS NULL,
        'unknown',NOT s.enabled OR c.remote_track_id IS NULL)
        ORDER BY i.ordinal) FROM playlist_items i JOIN music_sources s ON s.id=i.source_id
        LEFT JOIN catalog_tracks c ON c.source_id=i.source_id AND c.remote_track_id=i.remote_track_id
        WHERE i.playlist_id=p.id),'[]'::jsonb) AS items
      FROM playlists p WHERE p.id=$1 AND p.user_id=$2 AND p.deleted_at IS NULL`,[input.playlistId,input.userId])).rows[0];
    const conflict=(message:string):PlaybackCommandResult=>({status:'conflict',snapshot:before,error:{code:'PLAYLIST_NOT_READY',message}});
    const before=await this.snapshot(input.userId);
    if (!row || row.revision!==input.playlistRevision) return conflict('La playlist cambió o ya no está disponible. Actualízala.');
    if (row.items.some(i=>i.unknown)) return conflict('No pudimos confirmar toda la playlist. Se conservó la cola actual.');
    const items=uniqueTracks(row.items.filter(i=>i.available),i=>encodeTrackReference(i.source,i.track));
    if (!items.length) return conflict('La playlist no tiene pistas disponibles. Se conservó la cola actual.');
    const selected = input.itemId ? row.items.find(i=>i.id===input.itemId && i.available) : null;
    if (input.itemId && !selected) return conflict('La pista elegida no está disponible.');
    if (items.some(i=>i.source!==items[0]!.source)) return conflict('Esta reproducción requiere una misma fuente activa.');
    if (input.shuffle) for(let i=items.length-1;i>0;i--) {
      const j=Math.floor(Math.random()*(i+1)); [items[i],items[j]]=[items[j]!,items[i]!];
    }
    const result=await this.selectContext({...input,sourceId:items[0]!.source,remoteTrackIds:items.map(i=>i.track),
      selectedIndex:selected ? items.findIndex(i=>i.source===selected.source && i.track===selected.track) : 0,contextType:'playlist',contextRef:input.playlistId});
    const missing=row.items.filter(i=>!i.available).length;
    const repeated=row.items.length-missing-items.length;
    if (result.status==='accepted') {
      await this.db.query(`UPDATE queue_items q SET playlist_item_id=t.item
        FROM jsonb_to_recordset($1::jsonb) AS t(id uuid,item uuid) WHERE q.id=t.id`,
        [JSON.stringify(result.snapshot.queue.map((q,n)=>({id:q.id,item:items[n]!.id})))]);
      result.snapshot=await this.snapshot(input.userId);
    }
    if(result.status==='accepted' && (missing || repeated)) result.notice=[missing ? `Se omitieron ${missing} canciones que ya no están en la biblioteca. Se conservan en la playlist.` : '',repeated ? `${repeated} repetidas omitidas.` : ''].filter(Boolean).join(' ');
    return result;
  }

  public async selectFavorites(input:{userId:string;deviceId:string;commandId:string;expectedRevision:number;shuffle:boolean;trackRef:string|null;replaceQueueRevision?:number}):Promise<PlaybackCommandResult> {
    if(!this.insideCommand)return this.command('select-favorites',input,repo=>repo.selectFavorites(input));
    const before=await this.snapshot(input.userId);
    const reject=(message:string):PlaybackCommandResult=>({status:'conflict',snapshot:before,error:{code:'FAVORITES_NOT_READY',message}});
    const rows=(await this.db.query<{source_id:string;remote_entity_id:string;enabled:boolean;known:boolean;missing:boolean}>(`
      SELECT f.source_id,f.remote_entity_id,s.enabled,c.remote_track_id IS NOT NULL AS known,c.missing_since IS NOT NULL AS missing
      FROM user_favorites f JOIN music_sources s ON s.id=f.source_id
      LEFT JOIN catalog_tracks c ON c.source_id=f.source_id AND c.remote_track_id=f.remote_entity_id
      WHERE f.user_id=$1 AND f.entity_type='track' ORDER BY f.created_at DESC,f.source_id,f.remote_entity_id LIMIT 5001`,[input.userId])).rows;
    if(rows.length>5000)return reject('Favoritos supera las 5.000 canciones permitidas en una cola. No se reprodujo una lista parcial.');
    if(rows.some(i=>!i.enabled||!i.known))return reject('No pudimos confirmar todos tus favoritos. Conservamos la cola anterior.');
    const tracks=rows.filter(i=>!i.missing);
    if(!tracks.length)return reject('No hay favoritos disponibles. Conservamos la cola anterior.');
    if(input.shuffle)for(let i=tracks.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[tracks[i],tracks[j]]=[tracks[j]!,tracks[i]!];}
    const selectedIndex=input.trackRef?tracks.findIndex(i=>encodeTrackReference(i.source_id,i.remote_entity_id)===input.trackRef):0;
    if(selectedIndex<0)return reject('Ese favorito ya no está disponible.');
    const result=await this.selectContext({...input,sourceId:tracks[0]!.source_id,remoteTrackIds:tracks.map(i=>i.remote_entity_id),selectedIndex,contextType:'favorites',contextRef:'favorites'});
    if(result.status==='accepted'&&rows.length>tracks.length)result.notice=`Se omitieron ${rows.length-tracks.length} favoritos ausentes; no se borraron de tu colección.`;
    return result;
  }

  public async select(input: {
    userId: string;
    deviceId: string;
    commandId: string;
    expectedRevision: number;
    sourceId: string;
    remoteTrackId: string;
  }): Promise<PlaybackCommandResult> {
    if (!this.insideCommand) return this.command('select', input, repo => repo.select(input));
    await this.ensureSession(input.userId);
    const before = await this.snapshot(input.userId);
    if (before.revision !== input.expectedRevision) return {status:'conflict',snapshot:before};
    const existing = before.queue.find(i=>i.trackRef===encodeTrackReference(input.sourceId,input.remoteTrackId));
    if (existing) return this.editQueue({...input,expectedQueueRevision:before.queueRevision,
      currentQueueItemId:before.currentQueueItemId,playbackInstanceId:before.playbackInstanceId,
      expectedStatus:before.status,operation:{action:'select',itemId:existing.id}});
    if (before.queue.length>=5000) return {status:'conflict',snapshot:before,
      error:{code:'QUEUE_LIMIT',message:'La cola admite 5.000 canciones. No se añadió otra.'}};
    const result = await this.db.query(
      `WITH candidate AS (
         SELECT s.id, s.active_device_id, s.lease_epoch, s.lease_expires_at
           FROM playback_sessions s
           JOIN devices d ON d.id = $2 AND d.user_id = $1 AND d.revoked_at IS NULL
           JOIN music_sources m ON m.id = $5 AND m.enabled
          WHERE s.user_id = $1 AND s.revision = $4
          FOR UPDATE OF s
       ), accepted AS (
         INSERT INTO playback_events
           (user_id, playback_session_id, device_id, event_type, occurred_at,
            command_id, payload)
         SELECT $1, candidate.id, $2, 'track.selected', statement_timestamp(), $3,
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
                status = 'playing', position_ms = 0, position_observed_at = statement_timestamp(),
                active_device_id = CASE
                  WHEN candidate.active_device_id IS NULL OR
                       candidate.lease_expires_at <= statement_timestamp() THEN $2
                  ELSE candidate.active_device_id END,
                lease_epoch = CASE
                  WHEN candidate.active_device_id IS NULL OR
                       candidate.lease_expires_at <= statement_timestamp() THEN candidate.lease_epoch + 1
                  ELSE candidate.lease_epoch END,
                lease_expires_at = CASE
                  WHEN candidate.active_device_id IS NULL OR
                       candidate.lease_expires_at <= statement_timestamp()
                    THEN statement_timestamp() + interval '${LEASE_SECONDS} seconds'
                  ELSE candidate.lease_expires_at END,
                revision = revision + 1, updated_at = statement_timestamp()
           FROM item, candidate
          WHERE s.id = item.playback_session_id AND s.id = candidate.id
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
    renderPhase?: PlaybackRenderPhase;
    positionMs: number;
    anchor: PlaybackAnchor;
  }): Promise<PlaybackCommandResult> {
    if (!this.insideCommand) return this.command('update', input, repo => repo.update(input));
    await this.ensureSession(input.userId);
    const result = await this.db.query(
      `WITH candidate AS (
         SELECT s.id
           FROM playback_sessions s
          WHERE s.user_id = $1 AND s.revision = $4
            AND s.active_device_id = $2 AND s.lease_epoch = $5
            AND s.lease_expires_at > statement_timestamp()
          FOR UPDATE OF s
       ), accepted AS (
         INSERT INTO playback_events
           (user_id, playback_session_id, device_id, event_type, occurred_at,
            position_ms, command_id, lease_epoch)
         SELECT $1, candidate.id, $2, 'playback.updated', statement_timestamp(), $6, $3, $5
           FROM candidate
         ON CONFLICT (user_id, command_id) DO NOTHING
         RETURNING playback_session_id
       ), touched AS (
         UPDATE devices SET last_seen_at = statement_timestamp()
          WHERE id = $2 AND user_id = $1 AND EXISTS (SELECT 1 FROM accepted)
       ), updated AS (
         UPDATE playback_sessions s
            SET status = $7, position_ms = $6, position_observed_at = statement_timestamp(),
                lease_expires_at = statement_timestamp() + interval '${LEASE_SECONDS} seconds',
                revision = revision + 1, updated_at = statement_timestamp()
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
    replaceQueueRevision?:number;
  }): Promise<PlaybackCommandResult> {
    if (!this.insideCommand) return this.command('select-context', input, repo => repo.selectContext(input));
    if(!input.remoteTrackIds.length || input.remoteTrackIds.length>5000 || input.selectedIndex<0 || input.selectedIndex>=input.remoteTrackIds.length) {
      return {status:'conflict',snapshot:await this.snapshot(input.userId),error:{code:'QUEUE_LIMIT',message:'El contexto debe tener entre 1 y 5.000 canciones; no se reprodujo una lista parcial.'}};
    }
    const selectedTrack=input.remoteTrackIds[input.selectedIndex]!;
    const remoteTrackIds=uniqueTracks(input.remoteTrackIds,id=>id);
    input={...input,remoteTrackIds,selectedIndex:remoteTrackIds.indexOf(selectedTrack)};
    await this.ensureSession(input.userId);
    const result = await this.db.query(
      `WITH candidate AS (
         SELECT s.id, s.active_device_id, s.lease_epoch, s.lease_expires_at
           FROM playback_sessions s
           JOIN devices d ON d.id = $2 AND d.user_id = $1 AND d.revoked_at IS NULL
           JOIN music_sources m ON m.id = $5 AND m.enabled
          WHERE s.user_id = $1 AND s.revision = $4
          FOR UPDATE OF s
       ), accepted AS (
         INSERT INTO playback_events
           (user_id, playback_session_id, device_id, event_type, occurred_at,
            command_id, payload)
         SELECT $1, candidate.id, $2, 'context.selected', statement_timestamp(), $3,
                jsonb_build_object('expectedRevision', $4::bigint, 'contextType', $8::text,
                                   'contextRef', $9::text, 'trackCount', cardinality($6::text[]))
           FROM candidate
         ON CONFLICT (user_id, command_id) DO NOTHING
         RETURNING playback_session_id
       ), removed AS (
         UPDATE queue_items SET removed_at = statement_timestamp()
          WHERE playback_session_id IN (SELECT playback_session_id FROM accepted)
            AND removed_at IS NULL
         RETURNING id
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
           CROSS JOIN (SELECT count(*) FROM removed) AS removal_barrier
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
                status = 'playing', position_ms = 0, position_observed_at = statement_timestamp(),
                active_device_id = CASE
                  WHEN candidate.active_device_id IS NULL OR
                       candidate.lease_expires_at <= statement_timestamp() THEN $2
                  ELSE candidate.active_device_id END,
                lease_epoch = CASE
                  WHEN candidate.active_device_id IS NULL OR
                       candidate.lease_expires_at <= statement_timestamp() THEN candidate.lease_epoch + 1
                  ELSE candidate.lease_epoch END,
                lease_expires_at = CASE
                  WHEN candidate.active_device_id IS NULL OR
                       candidate.lease_expires_at <= statement_timestamp()
                    THEN statement_timestamp() + interval '${LEASE_SECONDS} seconds'
                  ELSE candidate.lease_expires_at END,
                revision = revision + 1, updated_at = statement_timestamp()
           FROM target, candidate
          WHERE s.id = target.playback_session_id AND s.id = candidate.id
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

  public async setRepeat(input: RepeatCommand & { userId: string; deviceId: string }): Promise<PlaybackCommandResult> {
    if (!this.insideCommand) return this.command('repeat', input, repo => repo.setRepeat(input));
    const before = await this.snapshot(input.userId);
    // Progress may advance the session revision; changing context or mode must
    // never silently rebase a toggle made from an older view.
    if (input.expectedRevision > before.revision || input.expectedQueueRevision !== before.queueRevision
      || input.expectedRepeatMode !== before.repeatMode) {
      return { status: 'conflict', snapshot: before, error: {
        code: 'REPEAT_CHANGED', message: 'La cola o la repetición cambió. Revisa el modo actual.',
      } };
    }
    await this.db.query(`UPDATE playback_sessions SET repeat_mode=$2,revision=revision+1,
      updated_at=statement_timestamp() WHERE user_id=$1`, [input.userId, input.mode === 'off' ? 'none' : input.mode]);
    return { status: 'accepted', snapshot: await this.snapshot(input.userId) };
  }

  public async control(input: {
    userId: string;
    deviceId: string;
    commandId: string;
    expectedRevision: number;
    action: 'play' | 'pause' | 'next' | 'previous' | 'seek' | 'retry';
    positionMs?: number;
    reason?: 'user' | 'ended';
    anchor: PlaybackAnchor;
  }): Promise<PlaybackCommandResult> {
    if (!this.insideCommand) return this.command('control', input, repo => repo.control(input));
    if (input.action === 'retry') {
      const current = await this.snapshot(input.userId);
      if (!current.currentQueueItemId) return { status: 'conflict', snapshot: current };
      return this.control({ ...input, action: 'play' });
    }
    if (input.action === 'next' || input.action === 'previous') {
      return this.move(input, input.action);
    }
    await this.ensureSession(input.userId);
    const status = input.action === 'play' ? 'playing'
      : input.action === 'pause' ? 'paused' : null;
    const result = await this.db.query(
      `WITH candidate AS (
         SELECT s.id, s.active_device_id, s.lease_expires_at
          FROM playback_sessions s
          JOIN devices d ON d.id = $2 AND d.user_id = $1 AND d.revoked_at IS NULL
          WHERE s.user_id = $1 AND s.revision = $4
            AND s.current_queue_item_id IS NOT NULL
            AND ($5 = 'play' OR
                 (s.active_device_id IS NOT NULL AND s.lease_expires_at > statement_timestamp()))
          FOR UPDATE OF s
       ), accepted AS (
         INSERT INTO playback_events
           (user_id, playback_session_id, device_id, event_type, occurred_at,
            position_ms, command_id, payload)
         SELECT $1, candidate.id, $2, 'playback.controlled', statement_timestamp(), $6, $3,
                jsonb_build_object('action', $5::text)
           FROM candidate
         ON CONFLICT (user_id, command_id) DO NOTHING
         RETURNING playback_session_id
       ), updated AS (
         UPDATE playback_sessions s
            SET status = COALESCE($7, s.status),
                position_ms = CASE WHEN $5 = 'seek' THEN $6 ELSE s.position_ms END,
                position_observed_at = statement_timestamp(),
                active_device_id = CASE
                  WHEN $5 = 'play' AND
                       (candidate.active_device_id IS NULL OR
                        candidate.lease_expires_at <= statement_timestamp()) THEN $2
                  ELSE s.active_device_id END,
                lease_epoch = CASE
                  WHEN $5 = 'play' AND
                       (candidate.active_device_id IS NULL OR
                        candidate.lease_expires_at <= statement_timestamp()) THEN s.lease_epoch + 1
                  ELSE s.lease_epoch END,
                lease_expires_at = CASE
                  WHEN $5 = 'play' AND
                       (candidate.active_device_id IS NULL OR
                        candidate.lease_expires_at <= statement_timestamp())
                    THEN statement_timestamp() + interval '${LEASE_SECONDS} seconds'
                  ELSE s.lease_expires_at END,
                revision = revision + 1,
                updated_at = statement_timestamp()
           FROM accepted, candidate
          WHERE s.id = accepted.playback_session_id AND s.id = candidate.id
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
    if (!this.insideCommand) return this.command('queue-remove', input, repo => repo.removeQueueItem(input));
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
         SELECT $1, id, $2, $5, 'queue.removed', statement_timestamp(), $3 FROM candidate
         ON CONFLICT (user_id, command_id) DO NOTHING
         RETURNING playback_session_id
       ), removed AS (
         UPDATE queue_items SET removed_at = statement_timestamp()
          WHERE id = $5 AND EXISTS (SELECT 1 FROM accepted)
         RETURNING playback_session_id
       ), replacement AS (
         SELECT CASE WHEN c.current_queue_item_id = $5 THEN
             (SELECT q.id FROM queue_items q WHERE q.playback_session_id = c.id
                AND q.removed_at IS NULL AND q.ordinal > c.removed_ordinal
                ORDER BY q.ordinal LIMIT 1)
            ELSE c.current_queue_item_id END AS item_id,
           c.id, c.current_queue_item_id = $5 AS removed_current
           FROM candidate c WHERE EXISTS (SELECT 1 FROM accepted)
       ), updated AS (
         UPDATE playback_sessions s
            SET current_queue_item_id = replacement.item_id,
                position_ms = CASE WHEN replacement.removed_current THEN 0 ELSE s.position_ms END,
                position_observed_at = statement_timestamp(),
                status = CASE WHEN replacement.item_id IS NULL THEN 'stopped' ELSE s.status END,
                revision = revision + 1, updated_at = statement_timestamp()
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

  public async editQueue(input: QueueEditCommand & {userId:string;deviceId:string}):Promise<PlaybackCommandResult> {
    if (!this.insideCommand) return this.command('queue-edit',input,repo=>repo.editQueue(input));
    return editQueue(this.db,input,await this.snapshot(input.userId),()=>this.snapshot(input.userId));
  }

  public async failure(input: {
    userId: string; deviceId: string; commandId: string; expectedRevision: number;
    anchor: PlaybackAnchor; failure: PlaybackFailure;
  }): Promise<PlaybackCommandResult> {
    if (!this.insideCommand) return this.command('failure', input, repo => repo.failure(input));
    const before = await this.snapshot(input.userId);
    if (before.revision !== input.expectedRevision || before.activeDeviceId !== input.deviceId
      || !before.leaseExpiresAt || Date.parse(before.leaseExpiresAt) <= Date.now()
      || !['playing', 'paused'].includes(before.status) || !before.playbackInstanceId || !before.currentTrackRef) {
      return { status: 'conflict', snapshot: before };
    }
    const state = (await this.db.query<{ failure_state: FailureState }>(
      'SELECT failure_state FROM playback_sessions WHERE user_id=$1', [input.userId])).rows[0]!.failure_state;
    state.omitted = [...new Set([...(state.omitted ?? []), before.currentTrackRef])];
    state.consecutive = (state.consecutive ?? 0) + 1;
    state.since ??= Date.now() - Math.min(24_000, input.failure.elapsedMs);
    const blocked = ['autoplay', 'authentication', 'service_unavailable', 'offline'].includes(input.failure.code);
    const limited = state.consecutive >= 3 || Date.now() - state.since >= 30_000;
    const paused = before.status === 'paused';
    const target = !paused && !blocked && !limited ? nextQueueItem(before.queue, before.currentQueueItemId,
      { omitted: state.omitted, failed: true, repeat: before.repeatMode }) : null;
    const notice: PlaybackFailureNotice = { ...input.failure, id: input.commandId,
      trackRef: before.currentTrackRef, occurredAt: new Date().toISOString(),
      outcome: target ? 'advanced' : blocked ? 'blocked' : paused ? 'paused' : limited ? 'limit' : 'end' };
    state.notices = [...(state.notices ?? []), notice].slice(-10);
    await this.db.query(`INSERT INTO playback_failures
      (id,user_id,device_id,playback_instance_id,attempt,track_ref,code,phase,position_ms,elapsed_ms,outcome)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [input.commandId,input.userId,input.deviceId,
      before.playbackInstanceId,before.attempt,before.currentTrackRef,notice.code,notice.phase,
      notice.positionMs,notice.elapsedMs,notice.outcome]);
    await this.db.query(`UPDATE playback_sessions SET current_queue_item_id=$2,
      position_ms=$3,position_observed_at=statement_timestamp(),status=$4,render_phase=$5,
      failure_state=$6::jsonb,revision=revision+1,updated_at=statement_timestamp()
      WHERE user_id=$1`, [input.userId,target?.id ?? before.currentQueueItemId,
      target ? 0 : notice.positionMs,target ? 'playing' : 'paused',target ? 'loading' : blocked ? 'blocked' : 'error',
      JSON.stringify(state)]);
    return { status: 'accepted', snapshot: await this.snapshot(input.userId) };
  }

  private async move(
    input: Parameters<PlaybackRepository['control']>[0],
    direction: 'next' | 'previous',
  ): Promise<PlaybackCommandResult> {
    await this.ensureSession(input.userId);
    const before = await this.snapshot(input.userId);
    const state = (await this.db.query<{failure_state: FailureState}>(
      'SELECT failure_state FROM playback_sessions WHERE user_id=$1',[input.userId])).rows[0]!.failure_state;
    const positionMs = input.deviceId === before.activeDeviceId && input.positionMs !== undefined
      ? input.positionMs : before.positionMs + (before.status === 'playing' && before.renderPhase === 'playing'
        ? Math.max(0, Date.now() - Date.parse(before.positionObservedAt)) : 0);
    const next = direction === 'next' ? nextQueueItem(before.queue,before.currentQueueItemId,
      {omitted: state.omitted, repeat: before.repeatMode === 'one' && input.reason !== 'ended' ? 'off' : before.repeatMode})
      : previousQueueItem(before.queue,before.currentQueueItemId,
        {omitted: state.omitted, repeat: before.repeatMode, positionMs});
    const result = await this.db.query(
      `WITH candidate AS (
         SELECT s.*, current.ordinal AS current_ordinal
           FROM playback_sessions s
          JOIN queue_items current ON current.id = s.current_queue_item_id
          WHERE s.user_id = $1 AND s.revision = $4
            AND s.active_device_id IS NOT NULL
            AND s.lease_expires_at > statement_timestamp()
          FOR UPDATE OF s
       ), target AS (
         SELECT candidate.id AS session_id,
                $6::uuid AS item_id
           FROM candidate
       ), accepted AS (
         INSERT INTO playback_events
           (user_id, playback_session_id, device_id, event_type, occurred_at,
            command_id, payload)
         SELECT $1, target.session_id, $2, 'playback.controlled', statement_timestamp(), $3,
                jsonb_build_object('action', $5::text)
           FROM target
         ON CONFLICT (user_id, command_id) DO NOTHING
         RETURNING playback_session_id
       ), updated AS (
         UPDATE playback_sessions s
            SET current_queue_item_id = COALESCE(target.item_id, s.current_queue_item_id),
                status = CASE WHEN target.item_id IS NULL THEN 'stopped' ELSE 'playing' END,
                position_ms = 0, position_observed_at = statement_timestamp(),
                revision = revision + 1, updated_at = statement_timestamp()
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
      [input.userId, input.deviceId, input.commandId, input.expectedRevision, direction, next?.id ?? null],
    );
    return this.commandResult(input.userId, input.commandId, Boolean(result.rowCount));
  }

  private async command<T extends {
    userId: string; deviceId: string; commandId: string; expectedRevision: number;
    anchor?: PlaybackAnchor; reason?: 'user' | 'ended'; action?: string;
    positionMs?: number;
    failure?: PlaybackFailure; renderPhase?: PlaybackRenderPhase; status?: PlaybackSnapshot['status'];
    replaceQueueRevision?:number; operation?:QueueEditCommand['operation'];
  }>(name: PlaybackCommandName, input: T,
    apply: (repository: PlaybackRepository) => Promise<PlaybackCommandResult>,
  ): Promise<PlaybackCommandResult> {
    if (!this.db.transaction) throw new Error('Playback commands require a transaction');
    await this.ensureSession(input.userId);
    return this.db.transaction(async connection => {
      const db: Database = { ...connection, close: async () => undefined };
      const repository = new PlaybackRepository(db, true);
      // Serialize commands per user, not per socket; snapshots below see one
      // transition while the row lock is held, and the outbox commits with it.
      await db.query('SELECT id FROM playback_sessions WHERE user_id = $1 FOR UPDATE', [input.userId]);
      const before = await repository.snapshot(input.userId);
      const validDevice = await db.query(
        'SELECT id FROM devices WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL',
        [input.deviceId, input.userId],
      );
      if (!validDevice.rowCount) return { status: 'conflict', snapshot: before };
      const requestHash = createHash('sha256').update(canonicalJson({ name, input })).digest('hex');
      const receipt = await db.query<{ request_hash: string }>(
        'SELECT request_hash FROM playback_command_receipts WHERE user_id = $1 AND command_id = $2',
        [input.userId, input.commandId],
      );
      if (receipt.rows[0]) {
        return receipt.rows[0].request_hash === requestHash
          ? { status: 'duplicate', snapshot: before }
          : { status: 'conflict', snapshot: before, error: {
              code: 'COMMAND_ID_REUSED', message: 'El identificador ya pertenece a otro comando.',
            } };
      }
      const replacing=name==='select-context' || name==='select-playlist' || name==='select-favorites';
      if (replacing && ((input.replaceQueueRevision!==undefined && input.replaceQueueRevision!==before.queueRevision)
        || (before.queueManuallyEdited && before.queue.length>(before.currentQueueItemId ? before.queue.findIndex(i=>i.id===before.currentQueueItemId)+1 : before.queuePastCount??0)
        && input.replaceQueueRevision!==before.queueRevision))) {
        return {status:'conflict',snapshot:before,error:{code:'QUEUE_REPLACE_CONFIRMATION',
          message:'La cola tiene cambios manuales. Confirma si quieres reemplazarla.'}};
      }
      if ((name === 'control' || name === 'update' || name === 'failure') && (!input.anchor
        || input.anchor.currentQueueItemId !== before.currentQueueItemId
        || input.anchor.playbackInstanceId !== before.playbackInstanceId
        || input.anchor.leaseEpoch !== before.leaseEpoch
        || (input.anchor.attempt ?? 0) !== before.attempt)) {
        return { status: 'conflict', snapshot: before };
      }
      if ((name === 'failure' || name === 'update') && ['error', 'blocked'].includes(before.renderPhase)) {
        return { status: 'conflict', snapshot: before };
      }
      // A stopped execution cannot be revived by a delayed renderer report,
      // even if its queue item and execution anchor have not changed.
      if (name === 'update' && (before.status === 'stopped' || !before.currentTrackRef)) {
        return { status: 'conflict', snapshot: before };
      }
      // Permission waiting is a paused render state, not a failure/retry episode.
      // A late report cannot override an explicit pause, seek or transfer.
      if (name === 'failure' && input.failure?.code === 'autoplay') {
        return { status: 'conflict', snapshot: before };
      }
      if (name === 'update' && input.renderPhase === 'awaiting_interaction'
        && (input.status !== 'paused' || (before.status !== 'playing'
          && before.renderPhase !== 'awaiting_interaction') || input.positionMs !== before.positionMs)) {
        return { status: 'conflict', snapshot: before };
      }
      if (name === 'update' && before.renderPhase === 'awaiting_interaction'
        && input.renderPhase !== 'awaiting_interaction') {
        return { status: 'conflict', snapshot: before };
      }
      if (name === 'control' && ['play', 'seek'].includes(input.action ?? '')
        && ['error', 'blocked'].includes(before.renderPhase)) {
        return { status: 'conflict', snapshot: before, error: {
          code: 'RETRY_REQUIRED', message: 'La pista falló. Usa Reintentar o Siguiente.',
        } };
      }
      const latestFailure = before.failures.at(-1);
      if (name === 'control' && input.action === 'retry' && latestFailure?.retryAfterMs
        && Date.now() < Date.parse(latestFailure.occurredAt) + latestFailure.retryAfterMs) {
        return { status: 'conflict', snapshot: before, error: {
          code: 'RETRY_LATER', message: 'El servicio pidió esperar antes de reintentar.',
        } };
      }
      if (input.reason === 'ended' && (input.action !== 'next'
        || before.status !== 'playing' || input.positionMs === undefined
        || before.activeDeviceId !== input.deviceId || !before.leaseExpiresAt
        || Date.parse(before.leaseExpiresAt) <= Date.now())) {
        return { status: 'conflict', snapshot: before };
      }
      const result = await apply(repository);
      if (result.status !== 'accepted') return result;
      if (name==='select-context' || name==='select-playlist' || name==='select-favorites') {
        await db.query(`UPDATE playback_sessions SET queue_manually_edited=false,queue_past_count=0,queue_undo=NULL,repeat_mode='none' WHERE user_id=$1`,[input.userId]);
        result.snapshot=await repository.snapshot(input.userId);
      }
      if (before.currentQueueItemId!==result.snapshot.currentQueueItemId) {
        await db.query(`UPDATE queue_items SET priority=false WHERE playback_session_id=$1 AND priority
          AND ordinal<=(SELECT ordinal FROM queue_items WHERE id=$2)`,[before.sessionId,result.snapshot.currentQueueItemId]);
        result.snapshot=await repository.snapshot(input.userId);
      }
      const after = result.snapshot;
      const changedItem = before.currentQueueItemId !== after.currentQueueItemId
        || name==='select'
        || (name==='queue-edit' && input.operation?.action==='select')
        || (name === 'control' && ['play','previous'].includes(input.action ?? '') && before.status === 'stopped')
        || (name === 'control' && input.action === 'next' && after.status === 'playing');
      const changedQueue = JSON.stringify(before.queue) !== JSON.stringify(after.queue);
      if (changedItem || changedQueue) {
        await db.query(`UPDATE playback_sessions
          SET playback_instance_id = $2, queue_revision = queue_revision + $3
          WHERE user_id = $1`, [input.userId,
          changedItem ? (after.currentQueueItemId ? randomUUID() : null) : before.playbackInstanceId,
          changedQueue ? 1 : 0]);
        result.snapshot = await repository.snapshot(input.userId);
      }
      const state = (await db.query<{ failure_state: FailureState }>(
        'SELECT failure_state FROM playback_sessions WHERE user_id=$1', [input.userId])).rows[0]!.failure_state;
      let phase = result.snapshot.renderPhase;
      let attempt = result.snapshot.attempt;
      if (changedItem) { attempt = 0; phase = after.status === 'playing' ? 'loading' : 'paused'; state.healthySince = undefined; }
      if (name === 'select' || name === 'select-context' || name === 'select-playlist' || name==='select-favorites' || name === 'claim'
        || (name==='queue-edit' && input.operation?.action==='select')
        || (name === 'control' && (input.action === 'retry' || (input.action === 'play' && changedItem)))) {
        state.consecutive = 0; state.since = undefined; state.omitted = []; state.healthySince = undefined;
      }
      if (name === 'control' && input.action === 'retry') { attempt += 1; phase = 'loading'; }
      if (name === 'control' && input.action === 'seek') {
        // A seek keeps the listening execution, but invalidates pending errors
        // and progress for the old audio position.
        attempt += 1;
        phase = after.status === 'playing' ? 'loading' : 'paused';
        state.healthySince = undefined;
      }
      if (name === 'control' && input.action === 'previous' && !changedItem && after.status === 'playing') {
        attempt += 1; phase = 'loading'; state.healthySince = undefined;
      }
      const resumeClaim = name === 'claim' && before.renderPhase === 'awaiting_interaction';
      if (name === 'claim') { attempt += 1; phase = resumeClaim || after.status === 'playing' ? 'loading' : 'paused'; }
      if (name === 'control' && input.action === 'pause' && !['error', 'blocked'].includes(before.renderPhase)) phase = 'paused';
      if (name === 'control' && input.action === 'pause' && before.renderPhase === 'awaiting_interaction') attempt += 1;
      if (name === 'update' && input.renderPhase === 'awaiting_interaction' && before.renderPhase !== 'awaiting_interaction') {
        if (state.since !== undefined) state.permissionBudgetMs = Math.max(0, 30_000 - (Date.now() - state.since));
        state.since = undefined;
      }
      if (name === 'control' && input.action === 'play' && before.renderPhase === 'awaiting_interaction'
        && state.permissionBudgetMs !== undefined) {
        state.since = Date.now() - (30_000 - state.permissionBudgetMs);
        state.permissionBudgetMs = undefined;
      }
      if (changedItem || name === 'claim' || (name === 'control' && ['pause','retry'].includes(input.action ?? ''))) {
        state.permissionBudgetMs = undefined;
      }
      if (name === 'control' && ['next', 'previous'].includes(input.action ?? '') && after.status === 'stopped') phase = 'paused';
      if (name === 'control' && input.action === 'play' && !changedItem) phase = 'loading';
      if (name === 'update') {
        phase = input.renderPhase ?? (after.status === 'playing' ? 'playing' : 'paused');
        if (phase === 'playing' && after.positionMs > before.positionMs) {
          state.healthySince ??= Date.now();
          if (Date.now() - state.healthySince >= 3_000) { state.consecutive = 0; state.since = undefined; }
        } else state.healthySince = undefined;
      }
      await db.query(`UPDATE playback_sessions SET playback_attempt=$2,render_phase=$3,failure_state=$4::jsonb,
        status=CASE WHEN $5 THEN 'playing' ELSE status END
        WHERE user_id=$1`, [input.userId, attempt, phase, JSON.stringify(state), resumeClaim]);
      result.snapshot = await repository.snapshot(input.userId);
      await db.query(`INSERT INTO playback_command_receipts (user_id, command_id, request_hash)
        VALUES ($1, $2, $3)`, [input.userId, input.commandId, requestHash]);
      await db.query(`INSERT INTO playback_activity_outbox (user_id, command_id, payload)
        VALUES ($1, $2, $3::jsonb)`, [input.userId, input.commandId, JSON.stringify({
          name, deviceId: input.deviceId, action: input.action ?? input.operation?.action, reason: input.reason,
          reportedPositionMs: input.failure?.positionMs ?? input.positionMs,
          // Queue metadata is not needed to project listening events.
          before: { ...before, queue: [] }, after: { ...result.snapshot, queue: [] },
        })]);
      return result;
    });
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
      `INSERT INTO playback_sessions (user_id)
       SELECT $1 WHERE NOT EXISTS (SELECT 1 FROM playback_sessions WHERE user_id = $1)
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
    priority:item.priority,playlistItemId:item.playlist_item_id,
    contextType:item.context_type,contextRef:item.context_ref,
  }));
  return {
    repeatMode: row.repeat_mode === 'none' ? 'off' : row.repeat_mode,
    attempt: row.playback_attempt ?? 0,
    renderPhase: row.render_phase ?? 'unknown',
    failures: (row.failure_state?.notices ?? []).filter(notice => notice.code !== 'autoplay'),
    recoveryDeadline: row.failure_state?.since === undefined ? null
      : new Date(row.failure_state.since + 30_000).toISOString(),
    sessionId: row.id,
    revision: Number(row.revision),
    protocolVersion: 5,
    queueRevision: Number(row.queue_revision),
    queueManuallyEdited:row.queue_manually_edited,
    queuePastCount:row.current_queue_item_id ? 0 : row.queue_past_count,
    queueUndo:row.queue_undo && row.queue_undo.revision===Number(row.queue_revision)
      && row.queue_undo.current===row.current_queue_item_id && row.queue_undo.instance===row.playback_instance_id
      && Date.parse(row.queue_undo.expiresAt)>Date.now() ? {id:row.queue_undo.id,expiresAt:row.queue_undo.expiresAt}:null,
    playbackInstanceId: row.playback_instance_id,
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

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
