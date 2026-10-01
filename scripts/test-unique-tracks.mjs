// Local disposable schemas only. Exercises upgrade from pre-uniqueness data.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import pg from 'pg';
import {createDatabase} from '../apps/api/dist/db/database.js';
import {PlaybackRepository} from '../apps/api/dist/playback/playback-repository.js';
import {PlaylistRepository} from '../apps/api/dist/playlists/playlist-repository.js';
import {encodeTrackReference} from '../apps/api/dist/music-source/track-reference.js';

const url=new URL(process.env.HIRMOS_TEST_DATABASE_URL??'');
assert.ok(['127.0.0.1','localhost'].includes(url.hostname)&&url.pathname==='/hirmos_core_test');
const admin=new pg.Client({connectionString:url.href});await admin.connect();
const schema=`hirmos_unique_${randomUUID().replaceAll('-','')}`;
await admin.query(`CREATE SCHEMA ${schema}`);
url.searchParams.set('options',`-c search_path=${schema} -c statement_timeout=15000`);
const db=createDatabase(url.href);let checks=0;const pass=message=>{checks++;console.log(`PASS ${message}`);};
try {
  const migration='0019_unique_playlist_queue_tracks.sql';
  for(const file of (await readdir(new URL('../database/migrations/',import.meta.url))).filter(f=>f.endsWith('.sql')&&f<migration).sort())
    await db.query(await readFile(new URL(`../database/migrations/${file}`,import.meta.url),'utf8'));
  const user=randomUUID(),other=randomUUID(),device=randomUUID(),remote=randomUUID();
  await db.query(`INSERT INTO users(id,email,display_name,role) VALUES($1,'unique@example.test','Unique','user'),($2,'past@example.test','Past','user')`,[user,other]);
  const source=(await db.query(`INSERT INTO music_sources(name,adapter_type,base_url,credential_ciphertext,encryption_key_version,enabled)
    VALUES('Synthetic','navidrome','https://music.example.test',decode('00','hex'),1,true) RETURNING id`)).rows[0].id;
  await db.query(`INSERT INTO catalog_tracks(source_id,remote_track_id,title,artist_name,album_name,duration_ms)
    SELECT $1,n::text,'Same title','Artist','Album',180000 FROM generate_series(1,5001)n`,[source]);
  const repo=new PlaybackRepository(db),lists=new PlaylistRepository(db);
  await repo.registerDevice({userId:user,deviceId:device,name:'PC',type:'desktop'});
  await repo.registerDevice({userId:user,deviceId:remote,name:'Remote',type:'mobile'});
  let s=await repo.snapshot(user);const past=await repo.snapshot(other);
  const refs=['1','2','1','3','2'],ids=refs.map(()=>randomUUID()),instance=randomUUID();
  await db.query(`INSERT INTO queue_items(id,playback_session_id,source_id,remote_track_id,ordinal,origin)
    SELECT i.id,$1,$2,i.track,i.n,'user' FROM jsonb_to_recordset($3::jsonb) AS i(id uuid,track text,n integer)`,
    [s.sessionId,source,JSON.stringify(refs.map((track,n)=>({id:ids[n],track,n})))]);
  await db.query(`UPDATE playback_sessions SET current_queue_item_id=$2,status='playing',position_ms=12345,
    playback_instance_id=$3,active_device_id=$4,lease_epoch=7,lease_expires_at=now()+interval '10 minutes',
    queue_undo='{"old":true}'::jsonb,render_phase='playing' WHERE id=$1`,[s.sessionId,ids[2],instance,device]);
  await db.query(`INSERT INTO queue_items(playback_session_id,source_id,remote_track_id,ordinal,origin)
    VALUES($1,$2,'1',0,'user'),($1,$2,'1',1,'user'),($1,$2,'2',2,'user')`,[past.sessionId,source]);
  await db.query(`UPDATE playback_sessions SET queue_past_count=2,queue_undo='{"old":true}'::jsonb WHERE id=$1`,[past.sessionId]);
  const list=await lists.command(user,{action:'create',commandId:randomUUID(),name:'Legacy A B A',description:''});
  await db.query(`INSERT INTO playlist_items(playlist_id,source_id,remote_track_id,ordinal,metadata)
    VALUES($1,$2,'1',0,'{}'),($1,$2,'2',1,'{}'),($1,$2,'1',2,'{}')`,[list.playlistId,source]);
  await db.query(`INSERT INTO playback_checkpoints(playback_session_id,queue_item_id,revision,position_ms,status,device_id,lease_epoch,observed_at)
    VALUES($1,$2,0,12345,'playing',$3,7,now())`,[s.sessionId,ids[0],device]);
  const before=(await db.query('SELECT * FROM playback_sessions WHERE id=$1',[s.sessionId])).rows[0];
  await db.query(await readFile(new URL(`../database/migrations/${migration}`,import.meta.url),'utf8'));
  const after=(await db.query('SELECT * FROM playback_sessions WHERE id=$1',[s.sessionId])).rows[0];
  for(const key of ['current_queue_item_id','position_ms','status','playback_instance_id','active_device_id','lease_epoch','lease_expires_at','position_observed_at','playback_attempt','render_phase'])
    assert.deepEqual(after[key],before[key],key);
  assert.equal(Number(after.queue_revision),Number(before.queue_revision)+1);assert.equal(after.queue_undo,null);
  s=await repo.snapshot(user);assert.deepEqual(s.queue.map(i=>i.id),[ids[1],ids[2],ids[3]]);
  assert.equal((await db.query('SELECT count(*)::int n FROM queue_items WHERE playback_session_id=$1',[s.sessionId])).rows[0].n,5);
  assert.equal((await db.query('SELECT count(*)::int n FROM playback_checkpoints')).rows[0].n,1);
  assert.equal((await repo.snapshot(other)).queuePastCount,1);
  const page=await lists.page(user,list.playlistId);
  assert.deepEqual(page.items.map(i=>i.track.id),['1','2'].map(t=>encodeTrackReference(source,t)));
  assert.deepEqual(page.items.map(i=>i.ordinal),[0,1]);assert.equal(page.playlist.revision,1);
  pass('upgrade preserves current duplicate, position, lease, execution and history; repairs past boundary and playlists');
  await assert.rejects(db.query(`INSERT INTO queue_items(playback_session_id,source_id,remote_track_id,ordinal,origin) VALUES($1,$2,'1',99,'user')`,[s.sessionId,source]),e=>e.code==='23505');
  await assert.rejects(db.query(`INSERT INTO playlist_items(playlist_id,source_id,remote_track_id,ordinal,metadata) VALUES($1,$2,'1',99,'{}')`,[list.playlistId,source]),e=>e.code==='23505');
  pass('database enforces both invariants even outside application helpers');
  const ref=n=>encodeTrackReference(source,String(n));
  const edit=(state,operation)=>({userId:user,deviceId:remote,commandId:randomUUID(),expectedRevision:state.revision,
    expectedQueueRevision:state.queueRevision,currentQueueItemId:state.currentQueueItemId,
    playbackInstanceId:state.playbackInstanceId,expectedStatus:state.status,operation});
  const names=state=>state.queue.map(i=>Buffer.from(i.trackRef,'base64url').toString().split('\0')[1]);
  const request=edit(s,{action:'add',placement:'queue',trackRefs:[ref(1),ref(2),ref(3),ref(4),ref(5)]});
  let result=await repo.editQueue(request);assert.equal(result.status,'accepted');assert.match(result.notice,/2 añadidas/);assert.match(result.notice,/3 repetidas/);
  assert.deepEqual(names(result.snapshot),['2','1','4','5','3']);
  assert.deepEqual(result.snapshot.queue.filter(i=>s.queue.some(old=>old.id===i.id)).map(i=>i.id),s.queue.map(i=>i.id));
  assert.equal(result.snapshot.positionMs,12345);assert.equal(result.snapshot.playbackInstanceId,instance);assert.equal(result.snapshot.activeDeviceId,device);
  assert.equal((await repo.editQueue(request)).status,'duplicate');s=result.snapshot;
  pass('five-track batch with three existing adds only two; previous/current/future and retries safe');
  const frozen=s;const noop=edit(s,{action:'add',placement:'next',trackRefs:[ref(1),ref(2)]});
  result=await repo.editQueue(noop);assert.equal(result.status,'accepted');assert.match(result.notice,/ya están/);
  assert.deepEqual(result.snapshot,frozen);assert.equal((await repo.editQueue(noop)).status,'duplicate');
  pass('all-existing batch is informational no-op, preserving queue revision, order and playback');
  await db.query(`UPDATE catalog_tracks SET missing_since=now() WHERE source_id=$1 AND remote_track_id='1'`,[source]);
  result=await repo.editQueue(edit(s,{action:'add',placement:'end',trackRefs:[ref(1)]}));
  assert.equal(result.status,'accepted');assert.deepEqual(result.snapshot,s);
  await db.query('UPDATE catalog_tracks SET missing_since=NULL WHERE source_id=$1',[source]);
  result=await repo.editQueue(edit(s,{action:'add',placement:'end',trackRefs:[ref(7),ref(7)]}));
  assert.equal(result.status,'accepted');assert.match(result.notice,/1 añadidas/);assert.match(result.notice,/1 repetidas/);
  s=result.snapshot;assert.equal(s.queue.filter(i=>i.trackRef===ref(7)).length,1);
  pass('already-queued unavailable track is still a no-op; internal batch duplicates add once');
  const race=edit(s,{action:'add',placement:'end',trackRefs:[ref(6)]});
  const racers=await Promise.all([repo.editQueue(race),repo.editQueue({...race,commandId:randomUUID(),deviceId:device})]);
  assert.equal(racers.filter(r=>r.status==='accepted').length,1);s=await repo.snapshot(user);
  result=await repo.editQueue(edit(s,{action:'add',placement:'end',trackRefs:[ref(6)]}));assert.deepEqual(result.snapshot,s);
  pass('two devices cannot insert the same song twice; refreshed retry is a no-op');
  const context={userId:user,deviceId:remote,commandId:randomUUID(),expectedRevision:s.revision,replaceQueueRevision:s.queueRevision,
    sourceId:source,remoteTrackIds:['1','2','1','3','2'],selectedIndex:2,contextType:'album',contextRef:'album'};
  result=await repo.selectContext(context);assert.equal(result.status,'accepted');s=result.snapshot;
  assert.deepEqual(names(s),['1','2','3']);assert.equal(s.currentQueueItemId,s.queue[0].id);assert.equal(s.activeDeviceId,device);
  pass('A B A C B context becomes A B C and selection maps to first occurrence');
  const originalId=s.queue[1].id;
  s=(await repo.select({userId:user,deviceId:remote,commandId:randomUUID(),expectedRevision:s.revision,sourceId:source,remoteTrackId:'2'})).snapshot;
  assert.equal(s.currentQueueItemId,originalId);assert.equal(s.queue.length,3);assert.equal(s.activeDeviceId,device);
  pass('legacy single-select reuses existing queue entry rather than inserting a duplicate');
  const selected=list.playlistId;
  const add=await lists.command(user,{action:'add',commandId:randomUUID(),playlistId:selected,expectedRevision:1,trackRefs:[ref(1),ref(2),ref(3),ref(3)],duplicates:'skip'});
  assert.equal(add.added,1);assert.equal(add.skipped,3);
  const no=await lists.command(user,{action:'add',commandId:randomUUID(),playlistId:selected,expectedRevision:add.revision,trackRefs:[ref(1)],duplicates:'skip'});
  assert.equal(no.revision,add.revision);assert.equal(no.added,0);
  const copied=await lists.command(user,{action:'duplicate',commandId:randomUUID(),playlistId:selected,expectedRevision:add.revision,name:'Copy'});
  assert.equal((await lists.page(user,copied.playlistId)).playlist.count,3);
  pass('playlist addition, no-op and duplication retain uniqueness');
  s=(await repo.selectContext({...context,commandId:randomUUID(),expectedRevision:s.revision,replaceQueueRevision:s.queueRevision,
    remoteTrackIds:Array.from({length:4999},(_,i)=>String(i+1)),selectedIndex:0})).snapshot;
  result=await repo.editQueue(edit(s,{action:'add',placement:'end',trackRefs:[ref(1),ref(5000),ref(5000)]}));
  assert.equal(result.status,'accepted');s=result.snapshot;assert.equal(s.queue.length,5000);
  assert.equal((await repo.editQueue(edit(s,{action:'add',placement:'end',trackRefs:[ref(1)]}))).status,'accepted');
  assert.equal((await repo.editQueue(edit(s,{action:'add',placement:'end',trackRefs:[ref(5001)]}))).error.code,'QUEUE_LIMIT');
  s=(await repo.select({userId:user,deviceId:remote,commandId:randomUUID(),expectedRevision:s.revision,sourceId:source,remoteTrackId:'5000'})).snapshot;
  assert.equal(s.currentTrackRef,ref(5000));assert.equal(s.queue.length,5000);
  pass('capacity counts new unique tracks; selecting existing track works at 5000');
  console.log(`${checks} uniqueness integration groups passed`);
} finally {await db.close();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
