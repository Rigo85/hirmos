import { randomUUID } from 'node:crypto';
import type { PlaybackCommandResult, PlaybackQueueItem, PlaybackSnapshot, QueueEditCommand } from '@hirmos/contracts';
import { nextQueueItem } from '@hirmos/domain';
import type { Database } from '../db/database.js';
import { decodeTrackReference, encodeTrackReference } from '../music-source/track-reference.js';

type Input = QueueEditCommand & { userId: string; deviceId: string };
interface SavedUndo {
  id: string; expiresAt: string; revision: number; current: string | null; instance: string | null;
  order: { id: string; priority: boolean }[]; removed: string[]; manuallyEdited: boolean; pastCount: number;
}

/** Called only inside the existing per-user playback transaction. */
export async function editQueue(db: Database, input: Input, before: PlaybackSnapshot,
  snapshot: () => Promise<PlaybackSnapshot>): Promise<PlaybackCommandResult> {
  const reject = (message: string, code = 'QUEUE_CHANGED'): PlaybackCommandResult =>
    ({ status: 'conflict', snapshot: before, error: { code, message } });
  if (input.expectedQueueRevision !== before.queueRevision
    || input.currentQueueItemId !== before.currentQueueItemId
    || input.playbackInstanceId !== before.playbackInstanceId
    || (before.status === 'stopped' && input.expectedStatus !== 'stopped')) {
    return reject('La cola o la canción actual cambió. Revisa el nuevo orden antes de intentarlo.');
  }
  const op = input.operation;
  const currentIndex = before.currentQueueItemId ? before.queue.findIndex(i => i.id === before.currentQueueItemId) : (before.queuePastCount??0)-1;
  let pastCount=before.currentQueueItemId ? currentIndex : before.queuePastCount??0;
  let order = before.queue.map(i => ({ ...i }));
  let undo: SavedUndo | null = null;
  let notice: string | undefined;
  let removed: string[] = [];
  let manuallyEdited = true;

  if (op.action === 'add' || op.action === 'add-playlist') {
    const existing = new Set(order.map(i => i.trackRef));
    let tracks: { sourceId: string; remoteId: string; playlistItemId: string | null }[];
    if (op.action === 'add-playlist') {
      const list = (await db.query<{ revision: number; items: { source: string; track: string; id: string; available: boolean; unknown: boolean }[] }>(`
        SELECT p.revision, COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'source',i.source_id,'track',i.remote_track_id,'id',i.id,
          'available',s.enabled AND c.remote_track_id IS NOT NULL AND c.missing_since IS NULL,
          'unknown',NOT s.enabled OR c.remote_track_id IS NULL) ORDER BY i.ordinal)
          FROM playlist_items i JOIN music_sources s ON s.id=i.source_id
          LEFT JOIN catalog_tracks c ON c.source_id=i.source_id AND c.remote_track_id=i.remote_track_id
          WHERE i.playlist_id=p.id),'[]'::jsonb) AS items
        FROM playlists p WHERE p.id=$1 AND p.user_id=$2 AND p.deleted_at IS NULL`,
      [op.playlistId, input.userId])).rows[0];
      if (!list || list.revision !== op.playlistRevision) return reject('La playlist cambió o ya no está disponible. Actualízala.');
      if (list.items.some(i => i.unknown && !existing.has(encodeTrackReference(i.source,i.track)))) return reject('No pudimos confirmar la playlist. La cola no cambió.', 'TRACK_UNAVAILABLE');
      tracks = list.items.filter(i => i.available || existing.has(encodeTrackReference(i.source,i.track))).map(i => ({ sourceId: i.source, remoteId: i.track, playlistItemId: i.id }));
      if (tracks.length < list.items.length) notice = `Se omitieron ${list.items.length - tracks.length} pistas ausentes; siguen guardadas en la playlist.`;
    } else {
      const refs = op.trackRefs.map(decodeTrackReference);
      if (refs.some((r, i) => !r || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(r.sourceId)
        || encodeTrackReference(r.sourceId, r.remoteId) !== op.trackRefs[i])) return reject('Referencia musical no válida.', 'INVALID_TRACK');
      tracks = refs.map(r => ({ ...r!, playlistItemId: null }));
    }
    if (!tracks.length) return reject('No hay canciones disponibles para añadir.', 'EMPTY_QUEUE');
    const total = tracks.length;
    tracks = tracks.filter(t => {
      const ref = encodeTrackReference(t.sourceId, t.remoteId);
      if (existing.has(ref)) return false;
      existing.add(ref); return true;
    });
    const repeated = total - tracks.length;
    if (!tracks.length) return { status:'accepted', snapshot:before,
      notice:[notice,'Estas canciones ya están en la cola.'].filter(Boolean).join(' ') };
    if (order.length + tracks.length > 5000) return reject('La cola admite 5.000 canciones. No se añadió ninguna.', 'QUEUE_LIMIT');
    if (op.action==='add') {
      const available = await db.query<{ source_id: string; remote_track_id: string }>(`
        SELECT DISTINCT c.source_id,c.remote_track_id FROM jsonb_to_recordset($1::jsonb)
          AS t("sourceId" uuid,"remoteId" text)
        JOIN catalog_tracks c ON c.source_id=t."sourceId" AND c.remote_track_id=t."remoteId"
        JOIN music_sources s ON s.id=c.source_id AND s.enabled WHERE c.missing_since IS NULL`, [JSON.stringify(tracks)]);
      const keys = new Set(available.rows.map(r => encodeTrackReference(r.source_id, r.remote_track_id)));
      if (tracks.some(t => !keys.has(encodeTrackReference(t.sourceId,t.remoteId)))) return reject('No pudimos confirmar todas las pistas. No se añadió ninguna.', 'TRACK_UNAVAILABLE');
    }
    let destination = currentIndex + 1;
    if (op.placement === 'queue') while (order[destination]?.priority) destination++;
    if (op.placement === 'end') destination = order.length;
    const added = tracks.map(t => ({ id: randomUUID(), source: t.sourceId, track: t.remoteId,
      playlistItemId: t.playlistItemId, priority: op.placement !== 'end' }));
    // Allocate above all retained/removed ordinals, so the existing unique
    // constraint is never temporarily violated during reorder or undo.
    await db.query(`INSERT INTO queue_items(id,playback_session_id,source_id,remote_track_id,ordinal,origin,priority,playlist_item_id,context_type,context_ref)
      SELECT t.id,$1,t.source,t.track,
        COALESCE((SELECT max(ordinal)+1 FROM queue_items WHERE playback_session_id=$1),0)+t.n,
        'user',t.priority,t."playlistItemId",$3,$4
      FROM jsonb_to_recordset($2::jsonb) AS t(id uuid,source uuid,track text,n integer,priority boolean,"playlistItemId" uuid)`,
    [before.sessionId, JSON.stringify(added.map((a, n) => ({ ...a, n }))), op.action === 'add-playlist' ? 'playlist' : null,
      op.action === 'add-playlist' ? op.playlistId : null]);
    order.splice(destination, 0, ...added.map(a => ({ id: a.id, trackRef: encodeTrackReference(a.source, a.track),
      ordinal: 0, origin: 'user', priority: a.priority, playlistItemId: a.playlistItemId })));
    notice = [notice, `${tracks.length} añadidas ${op.placement === 'end' ? 'al final' : op.placement === 'next' ? 'a continuación' : 'a tus siguientes'}.`,
      repeated ? `${repeated} repetidas omitidas (ya estaban en la cola o en la selección).` : ''].filter(Boolean).join(' ');
  } else if (op.action === 'move') {
    const selected = new Set(op.itemIds);
    if (selected.size !== op.itemIds.length || op.itemIds.some(id => !order.some(i => i.id === id))) return reject('La selección ya no está disponible.');
    if (order.slice(0, currentIndex + 1).some(i => selected.has(i.id))) return reject('Solo se pueden reordenar las canciones siguientes.');
    const moved = order.filter(i => selected.has(i.id)).map(i => ({ ...i, priority: op.priority }));
    order = order.filter(i => !selected.has(i.id));
    const destination = op.beforeId === null ? order.length : order.findIndex(i => i.id === op.beforeId);
    if (destination < currentIndex + 1) return reject('El destino debe estar después de la canción actual.');
    order.splice(destination, 0, ...moved);
  } else if (op.action === 'remove' || op.action === 'clear-upcoming') {
    removed = op.action === 'clear-upcoming' ? order.slice(currentIndex + 1).map(i => i.id) : op.itemIds;
    if (!removed.length || new Set(removed).size !== removed.length || removed.some(id => !order.some(i => i.id === id))) return reject('No quedan canciones de esa selección.');
    const chosen = new Set(removed);
    if (!chosen.has(before.currentQueueItemId ?? '')) {
      undo = { id: input.commandId, expiresAt: new Date(Date.now() + 30_000).toISOString(),
        revision: before.queueRevision + 1, current: before.currentQueueItemId, instance: before.playbackInstanceId,
        order: order.map(i => ({ id: i.id, priority: Boolean(i.priority) })), removed,
        manuallyEdited: Boolean(before.queueManuallyEdited),pastCount };
    }
    pastCount=order.slice(0,pastCount).filter(i=>!chosen.has(i.id)).length;
    order = order.filter(i => !chosen.has(i.id));
    await db.query('UPDATE queue_items SET removed_at=statement_timestamp() WHERE playback_session_id=$1 AND id=ANY($2::uuid[])', [before.sessionId, removed]);
    if (chosen.has(before.currentQueueItemId ?? '')) {
      const failed=(await db.query<{failure_state:{omitted?:string[]}}>('SELECT failure_state FROM playback_sessions WHERE user_id=$1',[input.userId])).rows[0]?.failure_state;
      const target = nextQueueItem(before.queue.filter(i => i.id === before.currentQueueItemId || !chosen.has(i.id)), before.currentQueueItemId,{omitted:failed?.omitted});
      await db.query(`UPDATE playback_sessions SET current_queue_item_id=$2, position_ms=0,
        position_observed_at=statement_timestamp(),status=CASE WHEN $2::uuid IS NULL THEN 'stopped' ELSE status END
        WHERE user_id=$1`, [input.userId, target?.id ?? null]);
    }
    notice = `${removed.length} canciones quitadas de la cola. No se borraron de tu biblioteca ni de tus playlists.`;
  } else if (op.action === 'undo') {
    const saved = (await db.query<{ queue_undo: SavedUndo | null }>('SELECT queue_undo FROM playback_sessions WHERE user_id=$1', [input.userId])).rows[0]?.queue_undo;
    if (!saved || saved.id !== op.undoId || Date.parse(saved.expiresAt) <= Date.now()
      || saved.revision !== before.queueRevision || saved.current !== before.currentQueueItemId || saved.instance !== before.playbackInstanceId) {
      return reject('Ya no se puede deshacer: cambió la cola, avanzó la reproducción o vencieron los 30 segundos.', 'UNDO_EXPIRED');
    }
    await db.query('UPDATE queue_items SET removed_at=NULL WHERE playback_session_id=$1 AND id=ANY($2::uuid[])', [before.sessionId, saved.removed]);
    const restored = await snapshot();
    const byId = new Map(restored.queue.map(i => [i.id, i]));
    order = saved.order.map(i => ({ ...byId.get(i.id)!, priority: i.priority }));
    manuallyEdited = saved.manuallyEdited;
    pastCount=saved.pastCount;
    notice = 'Se restauró la eliminación. La reproducción no cambió.';
  } else if (op.action === 'select') {
    if (!order.some(i => i.id === op.itemId)) return reject('Esa aparición ya no está en la cola.');
    await db.query(`UPDATE playback_sessions SET current_queue_item_id=$2,status='playing',position_ms=0,
      position_observed_at=statement_timestamp(),active_device_id=CASE WHEN active_device_id IS NULL OR lease_expires_at<=now() THEN $3 ELSE active_device_id END,
      lease_epoch=CASE WHEN active_device_id IS NULL OR lease_expires_at<=now() THEN lease_epoch+1 ELSE lease_epoch END,
      lease_expires_at=CASE WHEN active_device_id IS NULL OR lease_expires_at<=now() THEN now()+interval '30 seconds' ELSE lease_expires_at END
      WHERE user_id=$1`, [input.userId, op.itemId, input.deviceId]);
    manuallyEdited = Boolean(before.queueManuallyEdited);
  }

  // Only a contiguous pending prefix is priority. Moving an item into the
  // continuation never causes later hidden reordering.
  const current = (await snapshot()).currentQueueItemId;
  let prefix = true;
  const nowIndex = current ? order.findIndex(i => i.id === current) : pastCount-1;
  for (let n = 0; n < order.length; n++) {
    if (n <= nowIndex) order[n]!.priority = false;
    else { prefix = prefix && Boolean(order[n]!.priority); order[n]!.priority = prefix; }
  }
  await db.query(`UPDATE queue_items i SET ordinal=base.n+t.n,priority=t.priority
    FROM (SELECT COALESCE(max(ordinal)+1,0) AS n FROM queue_items WHERE playback_session_id=$1) base,
      jsonb_to_recordset($2::jsonb) AS t(id uuid,n integer,priority boolean)
    WHERE i.playback_session_id=$1 AND i.id=t.id`,
  [before.sessionId, JSON.stringify(order.map((i, n) => ({ id: i.id, n, priority: Boolean(i.priority) })))]);
  await db.query(`UPDATE playback_sessions SET queue_manually_edited=$2,queue_undo=$3::jsonb,queue_past_count=$4,
    revision=revision+1,updated_at=statement_timestamp() WHERE user_id=$1`,
  [input.userId, manuallyEdited, undo ? JSON.stringify(undo) : null,current ? 0 : pastCount]);
  await db.query(`INSERT INTO playback_events(user_id,playback_session_id,device_id,event_type,occurred_at,command_id,payload)
    VALUES($1,$2,$3,'queue.edited',statement_timestamp(),$4,$5::jsonb)`,
  [input.userId,before.sessionId,input.deviceId,input.commandId,JSON.stringify({action:op.action})]);
  return { status: 'accepted', snapshot: await snapshot(), ...(notice ? { notice } : {}) };
}
