// Isolated integration tests: local disposable PostgreSQL schemas only.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import pg from 'pg';
import { createDatabase } from '../apps/api/dist/db/database.js';
import { PlaybackRepository } from '../apps/api/dist/playback/playback-repository.js';
import { PlaybackActivityProjector } from '../apps/api/dist/playback/playback-activity-projector.js';
import { encodeTrackReference } from '../apps/api/dist/music-source/track-reference.js';

const url=new URL(process.env.HIRMOS_TEST_DATABASE_URL??'');
assert.ok(['127.0.0.1','localhost'].includes(url.hostname)&&url.pathname==='/hirmos_core_test');
const admin=new pg.Client({connectionString:url.href});await admin.connect();
const schema=`hirmos_repeat_${randomUUID().replaceAll('-','')}`;await admin.query(`CREATE SCHEMA ${schema}`);
url.searchParams.set('options',`-c search_path=${schema} -c statement_timeout=5000`);
const db=createDatabase(url.href);let count=0;const pass=s=>{count++;console.log(`PASS ${s}`);};
try {
  for(const file of (await readdir(new URL('../database/migrations/',import.meta.url))).filter(f=>f.endsWith('.sql')).sort())
    await db.query(await readFile(new URL(`../database/migrations/${file}`,import.meta.url),'utf8'));
  const user=randomUUID(),other=randomUUID(),desktop=randomUUID(),mobile=randomUUID(),foreign=randomUUID();
  await db.query(`INSERT INTO users(id,email,display_name,role) VALUES($1,'repeat@example.test','Repeat','user'),($2,'other@example.test','Other','user')`,[user,other]);
  const source=(await db.query(`INSERT INTO music_sources(name,adapter_type,base_url,credential_ciphertext,encryption_key_version,enabled)
    VALUES('Synthetic','navidrome','https://music.example.test',decode('00','hex'),1,true) RETURNING id`)).rows[0].id;
  await db.query(`INSERT INTO catalog_tracks(source_id,remote_track_id,title,artist_name,album_name,duration_ms)
    SELECT $1,n::text,'Track '||n,'Artist','Album',1500 FROM generate_series(1,4)n`,[source]);
  const repo=new PlaybackRepository(db);
  for(const [uid,id] of [[user,desktop],[user,mobile],[other,foreign]])await repo.registerDevice({userId:uid,deviceId:id,name:'Fixture',type:'desktop'});
  const ref=n=>encodeTrackReference(source,String(n));
  const anchor=s=>({currentQueueItemId:s.currentQueueItemId,playbackInstanceId:s.playbackInstanceId,leaseEpoch:s.leaseEpoch,attempt:s.attempt});
  const base=s=>({userId:user,deviceId:desktop,commandId:randomUUID(),expectedRevision:s.revision});
  const setting=(s,mode)=>({...base(s),deviceId:mobile,expectedQueueRevision:s.queueRevision,expectedRepeatMode:s.repeatMode,mode});
  const set=async(s,mode)=>(await repo.setRepeat(setting(s,mode))).snapshot;
  const control=(s,action,reason='user',deviceId=desktop,positionMs=1500)=>repo.control({...base(s),deviceId,action,reason,positionMs,anchor:anchor(s)});
  const edit=(s,operation)=>repo.editQueue({...base(s),deviceId:mobile,expectedQueueRevision:s.queueRevision,
    currentQueueItemId:s.currentQueueItemId,playbackInstanceId:s.playbackInstanceId,expectedStatus:s.status,operation});
  const start=async(tracks=['1','2','3'])=>{const s=await repo.snapshot(user);return (await repo.selectContext({...base(s),
    replaceQueueRevision:s.queueRevision,sourceId:source,remoteTrackIds:tracks,selectedIndex:0,contextType:'album',contextRef:'album'})).snapshot;};
  const fail=async(s,code='decode')=>(await repo.failure({...base(s),deviceId:s.activeDeviceId,anchor:anchor(s),
    failure:{code,phase:'stream',positionMs:100,elapsedMs:100}})).snapshot;
  let s=await repo.snapshot(user);assert.equal(s.repeatMode,'off');
  s=await set(s,'all');assert.equal(s.status,'stopped');assert.equal(s.activeDeviceId,null);
  s=await start();assert.equal(s.repeatMode,'off');
  const original=s;const request=setting(s,'one');s=(await repo.setRepeat(request)).snapshot;
  for(const key of ['positionMs','positionObservedAt','playbackInstanceId','attempt','activeDeviceId','leaseEpoch','leaseExpiresAt','queueRevision','status','renderPhase'])assert.equal(s[key],original[key],key);
  assert.equal((await repo.setRepeat(request)).status,'duplicate');
  assert.equal((await repo.setRepeat({...request,mode:'all'})).error.code,'COMMAND_ID_REUSED');
  assert.equal((await repo.setRepeat({...setting(s,'all'),deviceId:foreign})).status,'conflict');
  assert.equal((await new PlaybackRepository(db).snapshot(user)).repeatMode,'one');
  pass('default off; repeat is durable, idempotent, user-owned and never seeks or claims');

  const pending=setting(s,'all');
  s=(await repo.update({...base(s),anchor:anchor(s),leaseEpoch:s.leaseEpoch,status:'playing',renderPhase:'playing',positionMs:100})).snapshot;
  assert.equal((await repo.setRepeat(pending)).status,'accepted');s=await repo.snapshot(user);
  const stale=setting(s,'one');s=await set(s,'off');assert.equal((await repo.setRepeat(stale)).error.code,'REPEAT_CHANGED');
  const oldContext=setting(s,'one');s=await start();assert.equal((await repo.setRepeat(oldContext)).error.code,'REPEAT_CHANGED');
  const a=setting(s,'all'),b=setting(s,'one');
  assert.equal((await Promise.all([repo.setRepeat(a),repo.setRepeat(b)])).filter(r=>r.status==='accepted').length,1);
  pass('heartbeat tolerates pending setting; stale context/mode and simultaneous toggles cannot overwrite');

  s=await set(await start(['1']),'one');const item=s.currentQueueItemId,firstRun=s.playbackInstanceId;
  const end={...base(s),action:'next',reason:'ended',positionMs:1500,anchor:anchor(s)};
  assert.equal((await repo.control({...end,deviceId:mobile})).status,'conflict');
  s=(await repo.control(end)).snapshot;assert.equal(s.currentQueueItemId,item);assert.notEqual(s.playbackInstanceId,firstRun);
  assert.equal(s.positionMs,0);assert.equal(s.status,'playing');assert.equal(s.renderPhase,'loading');
  assert.equal((await repo.control(end)).status,'duplicate');
  assert.equal((await repo.control({...end,commandId:randomUUID(),expectedRevision:s.revision})).status,'conflict');
  const secondRun=s.playbackInstanceId;s=(await control(s,'next','ended')).snapshot;assert.notEqual(s.playbackInstanceId,secondRun);
  const projector=new PlaybackActivityProjector(db,{info(){},warn(){}});while(await projector.runBatch()){}
  const events=(await db.query(`SELECT event_type,count(*)::int AS n FROM listen_events WHERE queue_item_id=$1 GROUP BY event_type`,[item])).rows;
  assert.equal(events.find(e=>e.event_type==='completed')?.n,2);assert.equal(events.find(e=>e.event_type==='started')?.n,2);
  assert.equal(events.find(e=>e.event_type==='skipped'),undefined);
  assert.equal(Number((await db.query(`SELECT count(*) FROM playback_activity_instances WHERE id IN ($1,$2) AND closed`,[firstRun,secondRun])).rows[0].count),2);
  pass('repeat-one creates new executions even below 2s; old/duplicate/non-owner ends never double count');

  s=await set(await start(['1','2']),'one');s=(await control(s,'next','user',mobile)).snapshot;
  assert.equal(s.currentTrackRef,ref(2));assert.equal(s.repeatMode,'one');assert.equal(s.activeDeviceId,desktop);
  s=(await control(s,'next')).snapshot;assert.equal(s.status,'stopped');assert.equal(s.repeatMode,'one');
  const stoppedRun=s.playbackInstanceId;
  for (const status of ['paused','playing']) {
    const late=await repo.update({...base(s),anchor:anchor(s),leaseEpoch:s.leaseEpoch,status,renderPhase:status,positionMs:1652});
    assert.equal(late.status,'conflict');assert.deepEqual(late.snapshot,s);
  }
  s=(await control(s,'play')).snapshot;assert.notEqual(s.playbackInstanceId,stoppedRun);
  assert.equal(s.positionMs,0);
  pass('stopped execution rejects delayed reports even with fresh anchor; explicit play creates a new execution');
  pass('manual next escapes repeat-one, retains mode, stops at end and remote control keeps owner');

  s=await set(await start(['3','1','2']),'all');s=(await edit(s,{action:'add',placement:'queue',trackRefs:[ref(4)]})).snapshot;
  const order=s.queue.map(i=>i.id),visited=[s.currentQueueItemId];
  for(let n=0;n<4;n++){s=(await control(s,'next',n===3?'user':'ended')).snapshot;visited.push(s.currentQueueItemId);}
  assert.deepEqual(visited,[...order,order[0]]);assert.deepEqual(s.queue.map(i=>i.id),order);assert.equal(s.repeatMode,'all');
  pass('repeat-all reuses exact visible shuffled/edited order including requests without reinsertion');

  s=await set(await start(['1']),'all');const single=s.playbackInstanceId;s=(await control(s,'next')).snapshot;
  assert.equal(s.status,'playing');assert.notEqual(s.playbackInstanceId,single);assert.equal(s.queue.length,1);
  s=await start(['1']);s=(await control(s,'next','ended')).snapshot;assert.equal(s.status,'stopped');
  pass('single-entry all restarts, off ends; replacing context resets repetition');

  s=await set(await start(),'all');s=(await control(s,'pause')).snapshot;const paused=s;
  s=await set(s,'one');assert.equal(s.status,'paused');assert.equal(s.positionMs,paused.positionMs);
  s=(await repo.claim({...base(s),deviceId:mobile})).snapshot;assert.equal(s.repeatMode,'one');
  assert.equal(s.activeDeviceId,mobile);assert.equal(s.status,'paused');
  s=(await control(s,'play','user',mobile)).snapshot;
  assert.equal((await control(s,'next','ended',desktop)).status,'conflict');
  s=(await control(s,'next','ended',mobile)).snapshot;assert.equal(s.repeatMode,'one');
  pass('pause, snapshot and transfer preserve mode; old owner cannot finish the new lease');

  s=await set(await start(),'all');s=(await control(s,'next','user',mobile)).snapshot;
  s=(await edit(s,{action:'clear-upcoming'})).snapshot;assert.equal(s.queue.length,2);assert.equal(s.repeatMode,'all');
  s=(await control(s,'next','ended',s.activeDeviceId)).snapshot;assert.equal(s.currentTrackRef,ref(1));
  pass('clear upcoming preserves previous entries, repeat-all traverses the remaining queue');

  s=await start();s=(await control(s,'next','user',mobile)).snapshot;const currentRun=s.playbackInstanceId;
  // Renew/claim the test renderer explicitly after the previous transfer scenario.
  s=(await repo.claim({...base(s),deviceId:desktop})).snapshot;
  const beforeRestart=s;s=(await control(s,'previous','user',desktop,3500)).snapshot;
  assert.equal(s.currentTrackRef,ref(2));assert.equal(s.positionMs,0);assert.equal(s.playbackInstanceId,currentRun);
  assert.equal(s.attempt,beforeRestart.attempt+1);
  s=(await control(s,'previous','user',desktop,0)).snapshot;assert.equal(s.currentTrackRef,ref(1));
  const firstItem=s.currentQueueItemId;s=(await control(s,'previous','user',desktop,0)).snapshot;assert.equal(s.currentQueueItemId,firstItem);
  s=await set(s,'all');s=(await control(s,'previous','user',desktop,0)).snapshot;assert.equal(s.currentTrackRef,ref(3));
  pass('previous restarts after 3s, then moves backward; only all wraps to last');

  s=await set(await start(['1','2']),'one');s=await fail(s);assert.equal(s.currentTrackRef,ref(2));
  s=await fail(s);assert.equal(s.status,'paused');assert.equal(s.renderPhase,'error');
  s=await set(await start(['1','2']),'all');s=await fail(s);s=await fail(s);
  assert.equal(s.status,'paused');assert.equal(s.renderPhase,'error');assert.equal(s.failures.at(-1).outcome,'end');
  s=await set(await start(['1','2','3','4']),'all');for(let n=0;n<3;n++)s=await fail(s);
  assert.equal(s.status,'paused');assert.equal(s.failures.at(-1).outcome,'limit');
  s=await set(await start(['1','2']),'all');const beforeBlocked=s.currentQueueItemId;s=await fail(s,'service_unavailable');
  assert.equal(s.currentQueueItemId,beforeBlocked);assert.equal(s.renderPhase,'blocked');
  pass('failed recordings never loop; exhausted queue, three-failure breaker and service outages remain bounded');

  s=await start();const stable=s,change=setting(s,'one');
  const failingDb={...db,transaction:fn=>db.transaction(client=>fn({...client,query:(sql,values)=>{
    if(sql.includes('INSERT INTO playback_activity_outbox'))throw new Error('simulated outbox failure');return client.query(sql,values);
  }}))};
  await assert.rejects(new PlaybackRepository(failingDb).setRepeat(change),/simulated outbox failure/);
  assert.deepEqual(await repo.snapshot(user),stable);
  assert.equal(Number((await db.query('SELECT count(*) FROM playback_command_receipts WHERE user_id=$1 AND command_id=$2',[user,change.commandId])).rows[0].count),0);
  pass('repeat state, receipt and event rollback together on projection-outbox failure');
  console.log(`${count} repetition integration groups passed`);
} finally {await db.close();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
