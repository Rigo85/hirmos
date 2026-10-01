import { createHash, randomUUID } from 'node:crypto';
import { PLAYLIST_CAPACITY, type PlaylistCommand, type PlaylistCommandResult, type PlaylistItem, type PlaylistPage, type PlaylistSummary, type Track } from '@hirmos/contracts';
import type { Database } from '../db/database.js';
import { decodeTrackReference, encodeTrackReference } from '../music-source/track-reference.js';
import { uniqueTracks } from '../music-source/unique-tracks.js';

export class PlaylistError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 409) { super(message); }
}
type Connection = Pick<Database, 'query'>;
interface ItemRow { id: string; source_id: string; remote_track_id: string; ordinal: number; metadata: Track; origin_queue_item_id?: string | null }
interface ListRow { id: string; name: string; description: string; revision: number }

export class PlaylistRepository {
  constructor(private readonly db: Database) {}

  async list(userId: string): Promise<PlaylistSummary[]> {
    const result = await this.db.query<ListRow & { count: number; duration_ms: string; covers: string[] }>(`
      SELECT p.id,p.name,p.description,p.revision,count(i.id)::int AS count,
        COALESCE(sum((i.metadata->>'durationMs')::bigint),0)::text AS duration_ms,
        COALESCE((array_agg(DISTINCT i.metadata->>'coverUrl') FILTER
          (WHERE i.metadata->>'coverUrl' IS NOT NULL))[1:4],ARRAY[]::text[]) AS covers
      FROM playlists p LEFT JOIN playlist_items i ON i.playlist_id=p.id
      WHERE p.user_id=$1 AND p.deleted_at IS NULL
      GROUP BY p.id ORDER BY p.updated_at DESC,p.id`, [userId]);
    return result.rows.map(r => ({ id:r.id,name:r.name,description:r.description,revision:r.revision,
      count:r.count,durationMs:Number(r.duration_ms),covers:r.covers }));
  }

  async page(userId: string, id: string, offset = 0, revision?: number, query=''): Promise<PlaylistPage> {
    // A single statement fixes metadata, version and entries to one MVCC snapshot.
    const data = await this.db.query<ListRow & { items: ItemRow[]; count:number; matched:number; duration_ms:string; covers:string[] }>(`
      SELECT p.id,p.name,p.description,p.revision,
        (SELECT count(*)::int FROM playlist_items i WHERE i.playlist_id=p.id) AS count,
        (SELECT COALESCE(sum((metadata->>'durationMs')::bigint),0)::text FROM playlist_items i WHERE i.playlist_id=p.id) AS duration_ms,
        ARRAY(SELECT DISTINCT metadata->>'coverUrl' FROM playlist_items i WHERE i.playlist_id=p.id AND metadata->>'coverUrl' IS NOT NULL LIMIT 4) AS covers,
        (SELECT count(*)::int FROM playlist_items i WHERE i.playlist_id=p.id AND ($4='' OR position(lower($4) IN lower(concat_ws(' ',metadata->>'title',metadata->>'artist',metadata->>'album')))>0)) AS matched,
        COALESCE((SELECT jsonb_agg(to_jsonb(page) ORDER BY ordinal) FROM (
          SELECT i.* FROM playlist_items i WHERE i.playlist_id=p.id
          AND ($4='' OR position(lower($4) IN lower(concat_ws(' ',metadata->>'title',metadata->>'artist',metadata->>'album')))>0)
          ORDER BY ordinal LIMIT 100 OFFSET $3) page),'[]'::jsonb) AS items
      FROM playlists p WHERE p.id=$1 AND p.user_id=$2 AND p.deleted_at IS NULL`, [id,userId,offset,query]);
    const row = data.rows[0];
    if (!row) throw new PlaylistError('PLAYLIST_NOT_FOUND','No se encontró esta playlist.',404);
    if (revision !== undefined && revision !== row.revision) throw stale();
    const items = await this.hydrate(this.db, row.items,userId);
    return { playlist: { id:row.id,name:row.name,description:row.description,revision:row.revision,
      count:row.count,durationMs:Number(row.duration_ms),covers:row.covers },
      items,nextOffset:offset+100 < row.matched ? offset+100 : null };
  }

  async command(userId: string, command: PlaylistCommand): Promise<PlaylistCommandResult> {
    if (!this.db.transaction) throw new Error('Playlist commands require transactions');
    return this.db.transaction(async db => {
      // Serialise short mutations per owner, including create and its retry.
      const owner = await db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[userId]);
      if (!owner.rowCount) throw new PlaylistError('UNAUTHORIZED','La sesión ya no está disponible.',401);
      const hash = createHash('sha256').update(JSON.stringify(command)).digest('hex');
      const receipt = (await db.query<{request_hash:string; result:PlaylistCommandResult}>(
        'SELECT request_hash,result FROM playlist_command_receipts WHERE user_id=$1 AND command_id=$2',
        [userId,command.commandId])).rows[0];
      if (receipt) {
        if (receipt.request_hash !== hash) throw new PlaylistError('COMMAND_ID_REUSED','El comando ya se usó con otros datos.');
        return receipt.result;
      }
      let id: string, revision = 0, added = 0, skipped = 0;
      if (command.action === 'create' || command.action === 'from-queue') {
        id = randomUUID();
        await db.query('INSERT INTO playlists(id,user_id,name,description) VALUES($1,$2,$3,$4)',
          [id,userId,command.name,command.description]);
        if(command.action==='from-queue') {
          const queue=(await db.query<{queue_revision:string;current_queue_item_id:string|null;items:ItemRow[]}>(`
            SELECT s.queue_revision::text,s.current_queue_item_id,
              COALESCE((SELECT jsonb_agg(jsonb_build_object('source_id',q.source_id,'remote_track_id',q.remote_track_id,'origin_queue_item_id',q.id) ORDER BY q.ordinal)
                FROM (SELECT q.*,row_number() OVER(ORDER BY q.ordinal) AS position
                  FROM queue_items q WHERE q.playback_session_id=s.id AND q.removed_at IS NULL) q
                WHERE $2='all' OR (s.current_queue_item_id IS NULL AND q.position>s.queue_past_count)
                  OR (s.current_queue_item_id IS NOT NULL AND q.ordinal>=(SELECT ordinal FROM queue_items WHERE id=s.current_queue_item_id))), '[]'::jsonb) AS items
            FROM playback_sessions s WHERE user_id=$1`,[userId,command.scope])).rows[0];
          if(!queue || Number(queue.queue_revision)!==command.expectedQueueRevision || queue.current_queue_item_id!==command.currentQueueItemId) {
            throw new PlaylistError('QUEUE_CHANGED','La cola cambió. Revisa el nuevo orden antes de guardarla.');
          }
          if(!queue.items.length || queue.items.length>PLAYLIST_CAPACITY) throw new PlaylistError('QUEUE_LIMIT','La cola debe tener entre 1 y 5.000 canciones.');
          const unique=uniqueTracks(queue.items,i=>encodeTrackReference(i.source_id,i.remote_track_id));
          skipped=queue.items.length-unique.length;
          const prepared=unique.map((i,ordinal)=>({...i,id:randomUUID(),ordinal,metadata:{} as Track}));
          const tracks=await this.hydrate(db,prepared,userId);
          if(tracks.some(t=>!t.track.id)) throw new PlaylistError('TRACK_UNAVAILABLE','No pudimos recuperar los datos de todas las pistas. No se guardó una lista parcial.',503);
          await db.query(`INSERT INTO playlist_items(id,playlist_id,source_id,remote_track_id,ordinal,metadata,origin_queue_item_id)
            SELECT id,$1,source_id,remote_track_id,ordinal,metadata,origin_queue_item_id FROM jsonb_to_recordset($2::jsonb)
            AS t(id uuid,source_id uuid,remote_track_id text,ordinal integer,metadata jsonb,origin_queue_item_id uuid)`,
            [id,JSON.stringify(prepared.map((item,n)=>({...item,metadata:tracks[n]!.track})))]);
          added=prepared.length;
        }
      } else {
        id = command.playlistId;
        const row = (await db.query<ListRow>(`SELECT id,name,description,revision FROM playlists
          WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL FOR UPDATE`,[id,userId])).rows[0];
        if (!row) throw new PlaylistError('PLAYLIST_NOT_FOUND','No se encontró esta playlist.',404);
        if (row.revision !== command.expectedRevision) throw stale();
        const items = (await db.query<ItemRow>('SELECT * FROM playlist_items WHERE playlist_id=$1 ORDER BY ordinal',[id])).rows;
        revision = row.revision + 1;
        switch (command.action) {
          case 'rename': await db.query('UPDATE playlists SET name=$2,description=$3 WHERE id=$1',[id,command.name,command.description]); break;
          case 'delete': await db.query('UPDATE playlists SET deleted_at=now() WHERE id=$1',[id]); break;
          case 'duplicate': {
            id=randomUUID(); revision=0;
            await db.query('INSERT INTO playlists(id,user_id,name,description) VALUES($1,$2,$3,$4)',[id,userId,command.name,row.description]);
            await db.query(`INSERT INTO playlist_items(playlist_id,source_id,remote_track_id,ordinal,metadata)
              SELECT $1,source_id,remote_track_id,ordinal,metadata FROM playlist_items WHERE playlist_id=$2`,[id,row.id]);
            added=items.length; break;
          }
          case 'add': {
            const existing = new Set(items.map(i=>encodeTrackReference(i.source_id,i.remote_track_id)));
            const selected: string[]=[];
            for (const ref of command.trackRefs) {
              if (existing.has(ref)) { skipped++; continue; }
              selected.push(ref); existing.add(ref);
            }
            if (items.length+selected.length > PLAYLIST_CAPACITY) throw new PlaylistError('PLAYLIST_LIMIT',`El límite es ${PLAYLIST_CAPACITY} canciones; no se añadió ninguna.`);
            const identities=selected.map(ref=>{
              const identity=decodeTrackReference(ref);
              if (!identity || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identity.sourceId)
                || encodeTrackReference(identity.sourceId,identity.remoteId)!==ref)
                throw new PlaylistError('INVALID_TRACK','La referencia musical no es válida.',400);
              return identity;
            });
            const prepared: ItemRow[]=identities.map((ref,i)=>({ id:randomUUID(),source_id:ref.sourceId,
              remote_track_id:ref.remoteId,ordinal:items.length+i,metadata:{} as Track }));
            const tracks=await this.hydrate(db,prepared,userId);
            if (tracks.some(t=>t.availability!=='available')) throw new PlaylistError('TRACK_UNAVAILABLE',
              'No pudimos confirmar todas las pistas en el catálogo. No se añadió ninguna.',503);
            if (prepared.length) await db.query(`INSERT INTO playlist_items(id,playlist_id,source_id,remote_track_id,ordinal,metadata)
              SELECT id,$1,source_id,remote_track_id,ordinal,metadata FROM jsonb_to_recordset($2::jsonb)
              AS t(id uuid,source_id uuid,remote_track_id text,ordinal integer,metadata jsonb)`,
              [id,JSON.stringify(prepared.map((item,i)=>({...item,metadata:tracks[i]!.track})))]);
            added=prepared.length;
            if (!added) revision=row.revision;
            break;
          }
          case 'remove':
          case 'move': {
            const chosen=new Set(command.itemIds);
            if (chosen.size!==command.itemIds.length || command.itemIds.some(key=>!items.some(i=>i.id===key))) throw stale();
            const rest=items.filter(i=>!chosen.has(i.id));
            if (command.action==='remove') {
              await db.query('DELETE FROM playlist_items WHERE playlist_id=$1 AND id=ANY($2::uuid[])',[id,command.itemIds]);
            } else {
              const destination=command.beforeId===null ? rest.length : rest.findIndex(i=>i.id===command.beforeId);
              if (destination<0) throw new PlaylistError('INVALID_DESTINATION','El destino ya no está disponible.');
              rest.splice(destination,0,...items.filter(i=>chosen.has(i.id)));
            }
            await db.query(`UPDATE playlist_items i SET ordinal=s.ordinality-1 FROM
              unnest($2::uuid[]) WITH ORDINALITY AS s(id,ordinality) WHERE i.playlist_id=$1 AND i.id=s.id`,[id,rest.map(i=>i.id)]);
            break;
          }
        }
        if (command.action !== 'add' || added) await db.query('UPDATE playlists SET revision=$2,updated_at=now() WHERE id=$1',[id,revision]);
      }
      const result={playlistId:id,revision,added,skipped};
      await db.query('INSERT INTO playlist_command_receipts(user_id,command_id,request_hash,result) VALUES($1,$2,$3,$4)',
        [userId,command.commandId,hash,JSON.stringify(result)]);
      return result;
    });
  }

  private async hydrate(db:Connection, items:ItemRow[], userId:string):Promise<PlaylistItem[]> {
    if (!items.length) return [];
    const result=await db.query<{id:string; track:Record<string,unknown>|null; enabled:boolean; favorite:boolean}>(`
      SELECT input.id,to_jsonb(c) AS track,s.enabled,EXISTS(SELECT 1 FROM user_favorites f WHERE f.user_id=$2
        AND f.source_id=input.source_id AND f.entity_type='track' AND f.remote_entity_id=input.remote_track_id) AS favorite
      FROM jsonb_to_recordset($1::jsonb) AS input(id uuid,source_id uuid,remote_track_id text)
      JOIN music_sources s ON s.id=input.source_id
      LEFT JOIN catalog_tracks c ON c.source_id=input.source_id AND c.remote_track_id=input.remote_track_id`,[JSON.stringify(items),userId]);
    const byId=new Map(result.rows.map(r=>[r.id,r]));
    return items.map(item=>{
      const row=byId.get(item.id); const c=row?.track;
      const ref=(id:unknown)=>typeof id==='string' ? encodeTrackReference(item.source_id,id) : null;
      const cover=ref(c?.['cover_art_id']);
      const track:Track=c ? { id:encodeTrackReference(item.source_id,item.remote_track_id),
        title:String(c['title']),artist:String(c['artist_name']),album:String(c['album_name']),
        artistId:ref(c['remote_artist_id']),albumId:ref(c['remote_album_id']),durationMs:Number(c['duration_ms']),
        coverUrl:cover ? `/api/music/covers/${cover}` : null,year:c['release_year'] as number|null,
        genres:c['genres'] as string[],favorite:row?.favorite ?? false } : {...item.metadata,favorite:row?.favorite ?? false};
      return {id:item.id,ordinal:item.ordinal,track,originQueueItemId:item.origin_queue_item_id??null,availability:!row?.enabled ? 'source_unavailable'
        : !c ? 'unknown' : c['missing_since'] ? 'missing' : 'available'};
    });
  }
}
function stale():PlaylistError { return new PlaylistError('PLAYLIST_CHANGED','La playlist cambió en otro dispositivo. Actualízala antes de editar.'); }
