// Isolated PostgreSQL integration tests; never points at the production DB.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { createDatabase } from '../apps/api/dist/db/database.js';
import { PlaybackRepository } from '../apps/api/dist/playback/playback-repository.js';
import { PlaybackActivityProjector } from '../apps/api/dist/playback/playback-activity-projector.js';
import { PlaybackService } from '../apps/api/dist/playback/playback-service.js';
import { createSocketServer } from '../apps/api/dist/socket/socket-server.js';
import { createServer } from 'node:http';
import { io as connectSocket } from 'socket.io-client';

const url = new URL(process.env.HIRMOS_TEST_DATABASE_URL ?? '');
assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname) && url.pathname === '/hirmos_core_test',
  'Use a local, disposable database named hirmos_core_test');
const admin = new pg.Client({ connectionString: url.href });
await admin.connect();
const schema = `hirmos_core_${randomUUID().replaceAll('-', '')}`;
await admin.query(`CREATE SCHEMA ${schema}`);
url.searchParams.set('options', `-c search_path=${schema} -c statement_timeout=5000`);
const db = createDatabase(url.href);
const observer = new pg.Client({ connectionString: url.href });
await observer.connect();
const checks = [];
const check = (label) => { checks.push(label); console.log(`PASS ${label}`); };
const anchor = s => ({ attempt: s.attempt, currentQueueItemId: s.currentQueueItemId,
  playbackInstanceId: s.playbackInstanceId, leaseEpoch: s.leaseEpoch });
const logger = { info() {}, warn() {} };
try {
  let legacy;
  for (const file of (await readdir(new URL('../database/migrations/', import.meta.url))).filter(f => f.endsWith('.sql')).sort()) {
    if (file.startsWith('0013_')) {
      const user = randomUUID(), source = randomUUID(), session = randomUUID(), item = randomUUID();
      await db.query(`INSERT INTO users (id,email,display_name,role)
        VALUES ($1,'legacy@example.test','Legacy','user')`, [user]);
      await db.query(`INSERT INTO music_sources
        (id,name,adapter_type,base_url,credential_ciphertext,encryption_key_version,enabled)
        VALUES ($1,'Legacy','navidrome','https://music.example.test',decode('00','hex'),1,false)`, [source]);
      await db.query(`INSERT INTO playback_sessions (id,user_id,status,position_ms)
        VALUES ($1,$2,'paused',1234)`, [session, user]);
      await db.query(`INSERT INTO queue_items (id,playback_session_id,source_id,remote_track_id,ordinal,origin)
        VALUES ($1,$2,$3,'legacy',0,'manual')`, [item, session, source]);
      await db.query('UPDATE playback_sessions SET current_queue_item_id=$1 WHERE id=$2', [item, session]);
      await db.query(`INSERT INTO listen_events (user_id,source_id,remote_track_id,queue_item_id,event_type,position_ms)
        VALUES ($1,$2,'legacy',$3,'started',0)`, [user, source, item]);
      legacy = { user, source, item };
    }
    if (file.startsWith('0015_')) {
      await db.query(`UPDATE playback_sessions SET render_phase='blocked',status='paused',
        failure_state=$2::jsonb WHERE user_id=$1`,[legacy.user,JSON.stringify({since:Date.now(),consecutive:1,omitted:['legacy'],
          notices:[{id:randomUUID(),code:'autoplay',phase:'start',positionMs:1234,elapsedMs:0,
            trackRef:'legacy',occurredAt:new Date().toISOString(),outcome:'blocked'}]})]);
    }
    await db.query(await readFile(new URL(`../database/migrations/${file}`, import.meta.url), 'utf8'));
  }
  const migrated = await new PlaybackRepository(db).snapshot(legacy.user);
  assert.equal(migrated.currentQueueItemId, legacy.item);
  assert.equal(migrated.positionMs, 1234);
  assert.equal(migrated.queue.length, 1);
  assert.ok(migrated.playbackInstanceId);
  assert.equal(migrated.renderPhase,'awaiting_interaction');
  assert.deepEqual(migrated.failures,[]);
  assert.equal(migrated.recoveryDeadline,null);
  assert.equal((await db.query("SELECT jsonb_array_length(failure_state->'notices') AS n FROM playback_sessions WHERE user_id=$1",[legacy.user])).rows[0].n,1);
  assert.equal((await db.query('SELECT started FROM playback_activity_instances WHERE id=$1',
    [migrated.playbackInstanceId])).rows[0].started, true);
  await db.query('DELETE FROM users WHERE id=$1', [legacy.user]);
  await db.query('DELETE FROM music_sources WHERE id=$1', [legacy.source]);
  check('migrations preserve an existing queue, position and already-counted start');
  const user = randomUUID(), other = randomUUID(), desktop = randomUUID(), phone = randomUUID(), foreign = randomUUID();
  await db.query(`INSERT INTO users (id,email,display_name,role) VALUES
    ($1,'one@example.test','One','user'), ($2,'two@example.test','Two','user')`, [user, other]);
  const source = (await db.query(`INSERT INTO music_sources
    (name,adapter_type,base_url,credential_ciphertext,encryption_key_version,enabled)
    VALUES ('Fixture','navidrome','https://music.example.test',decode('00','hex'),1,true) RETURNING id`)).rows[0].id;
  const repo = new PlaybackRepository(db);
  for (const [userId, deviceId] of [[user, desktop], [user, phone], [other, foreign]]) {
    assert.equal(await repo.registerDevice({ userId, deviceId, name: 'Fixture', type: 'desktop' }), true);
  }
  let s = await repo.snapshot(user);
  assert.equal(s.protocolVersion, 5);
  assert.equal(s.playbackInstanceId, null);
  const select = { userId: user, deviceId: desktop, commandId: randomUUID(), expectedRevision: s.revision,
    sourceId: source, remoteTrackIds: ['a', 'b', 'c'], selectedIndex: 0, contextType: 'album', contextRef: 'fixture' };
  const duplicate = await Promise.all([repo.selectContext(select), repo.selectContext(select)]);
  assert.deepEqual(duplicate.map(r => r.status).sort(), ['accepted', 'duplicate']);
  s = (await repo.snapshot(user));
  assert.equal(s.queue.length, 3);
  assert.equal(s.queueRevision, 1);
  assert.ok(s.playbackInstanceId);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM playback_activity_outbox')).rows[0].n, 1);
  check('two concurrent deliveries produce one queue and one durable fact');
  assert.equal((await repo.selectContext({ ...select, selectedIndex: 1 })).error.code, 'COMMAND_ID_REUSED');
  check('same command ID with different payload rejected');
  assert.equal((await repo.claim({ userId: user, deviceId: foreign, commandId: randomUUID(), expectedRevision: s.revision })).status, 'conflict');
  assert.equal((await repo.snapshot(other)).queue.length, 0);
  check('device ownership and user isolation');

  const progress = { userId: user, deviceId: desktop, commandId: randomUUID(), expectedRevision: s.revision,
    leaseEpoch: s.leaseEpoch, status: 'playing', positionMs: 500, anchor: anchor(s) };
  s = (await repo.update(progress)).snapshot;
  assert.equal(s.queueRevision, 1);
  const instanceA = s.playbackInstanceId, firstAnchor = anchor(s);
  const remoteEnd = await repo.control({ userId: user, deviceId: phone, commandId: randomUUID(),
    expectedRevision: s.revision, action: 'next', reason: 'ended', positionMs: 1_000, anchor: anchor(s) });
  assert.equal(remoteEnd.status, 'conflict');
  check('remote controls cannot forge automatic completion');
  s = (await repo.control({ userId: user, deviceId: phone, commandId: randomUUID(), expectedRevision: s.revision,
    action: 'next', reason: 'user', anchor: anchor(s) })).snapshot;
  assert.equal(s.activeDeviceId, desktop);
  assert.notEqual(s.playbackInstanceId, instanceA);
  assert.notEqual(s.currentTrackRef, duplicate[0].snapshot.currentTrackRef);
  assert.equal(s.queueRevision, 1);
  check('advancing has a different execution, same player and queue revision; same-track repetition is covered by test:repeat:pg');
  assert.equal((await repo.control({ userId: user, deviceId: desktop, commandId: randomUUID(),
    expectedRevision: s.revision, action: 'next', reason: 'ended', positionMs: 1_000, anchor: firstAnchor })).status, 'conflict');
  assert.equal((await repo.update({ ...progress, commandId: randomUUID(), expectedRevision: s.revision })).status, 'conflict');
  check('late end and progress cannot affect another execution even with a fresh revision');

  const secondInstance = s.playbackInstanceId;
  s = (await repo.control({ userId: user, deviceId: phone, commandId: randomUUID(), expectedRevision: s.revision,
    action: 'seek', positionMs: 20_000, anchor: anchor(s) })).snapshot;
  assert.equal(s.playbackInstanceId, secondInstance);
  const previousEpoch = s.leaseEpoch;
  s = (await repo.claim({ userId: user, deviceId: phone, commandId: randomUUID(), expectedRevision: s.revision })).snapshot;
  assert.equal(s.playbackInstanceId, secondInstance);
  assert.equal(s.leaseEpoch, previousEpoch + 1);
  s = (await repo.update({ userId: user, deviceId: phone, commandId: randomUUID(), expectedRevision: s.revision,
    leaseEpoch: s.leaseEpoch, anchor: anchor(s), status: 'playing', positionMs: 20_500 })).snapshot;
  check('seek and transfer preserve execution; progress does not change queue revision');

  const failingDb = { ...db, transaction: fn => db.transaction(connection => fn({
    query: (sql, values) => {
      if (sql.includes('INSERT INTO playback_activity_outbox')) throw new Error('simulated outbox failure');
      return connection.query(sql, values);
    },
  })) };
  const failedId = randomUUID();
  await assert.rejects(new PlaybackRepository(failingDb).control({ userId: user, deviceId: phone, commandId: failedId,
    expectedRevision: s.revision, action: 'pause', anchor: anchor(s) }), /simulated outbox/);
  assert.deepEqual(await repo.snapshot(user), s);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM playback_command_receipts WHERE command_id=$1', [failedId])).rows[0].n, 0);
  check('outbox failure rolls back state, receipt and event atomically');

  // Hold a write on a separate physical connection. A snapshot must not mix
  // the new session fields with old/uncommitted queue contents.
  await observer.query('BEGIN');
  await observer.query(`UPDATE playback_sessions SET status='paused', revision=revision+1 WHERE user_id=$1`, [user]);
  const snapshotDuringWrite = await repo.snapshot(user);
  assert.deepEqual(snapshotDuringWrite, s);
  await observer.query('COMMIT');
  s = await repo.snapshot(user);
  assert.equal(s.status, 'paused');
  check('snapshot remains coherent while a separate connection holds uncommitted changes');

  const race = { userId: user, deviceId: phone, expectedRevision: s.revision, anchor: anchor(s) };
  const races = await Promise.all([
    repo.control({ ...race, commandId: randomUUID(), action: 'play' }),
    repo.control({ ...race, commandId: randomUUID(), action: 'pause' }),
  ]);
  assert.deepEqual(races.map(r => r.status).sort(), ['accepted', 'conflict']);
  check('different concurrent commands at one revision do not both execute');

  const failedProjection = { ...db, transaction: fn => db.transaction(connection => fn({
    query: (sql, values) => {
      if (sql.includes('INSERT INTO user_track_daily_stats')) throw new Error('simulated projection failure');
      return connection.query(sql, values);
    },
  })) };
  await assert.rejects(new PlaybackActivityProjector(failedProjection, logger).runBatch(), /simulated projection/);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM listen_events')).rows[0].n, 0);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM playback_activity_outbox WHERE processed_at IS NOT NULL')).rows[0].n, 0);
  check('failed projection rolls back aggregates, events and acknowledgements');
  const projector = new PlaybackActivityProjector(db, logger);
  await Promise.all([projector.runBatch(), new PlaybackActivityProjector(db, logger).runBatch()]);
  const stats = (await db.query('SELECT play_starts, listened_ms::int FROM user_track_stats WHERE user_id=$1', [user])).rows;
  assert.equal(stats.length, 2);
  assert.ok(stats.every(row=>row.play_starts===1 && row.listened_ms===500));
  assert.equal(await projector.runBatch(), 0);
  check('durable replay is idempotent; two tracks count once each, seek contributes no listening time');

  s = (await repo.selectContext({ ...select, commandId: randomUUID(),
    expectedRevision: (await repo.snapshot(user)).revision, remoteTrackIds: ['short'] })).snapshot;
  const terminal = { userId: user, deviceId: s.activeDeviceId, commandId: randomUUID(),
    expectedRevision: s.revision, anchor: anchor(s), action: 'next', reason: 'ended', positionMs: 700 };
  s = (await repo.control(terminal)).snapshot;
  assert.equal(s.status, 'stopped');
  assert.equal((await repo.control(terminal)).status, 'duplicate');
  assert.equal((await repo.control({ ...terminal, commandId: randomUUID(), expectedRevision: s.revision })).status, 'conflict');
  await projector.runBatch();
  const short = (await db.query(`SELECT play_starts, completions, listened_ms::int
    FROM user_track_stats WHERE user_id=$1 AND remote_track_id='short'`, [user])).rows[0];
  assert.deepEqual(short, { play_starts: 1, completions: 1, listened_ms: 700 });
  check('short tracks can complete before the first heartbeat, exactly once');
  const completedInstance = s.playbackInstanceId;
  s = (await repo.control({ userId: user, deviceId: phone, commandId: randomUUID(), expectedRevision: s.revision,
    action: 'play', anchor: anchor(s) })).snapshot;
  assert.notEqual(s.playbackInstanceId, completedInstance);
  check('playing again after the end creates another execution');

  await socketChecks(new PlaybackService(repo), user, other, foreign);
  check('real Socket.IO rejects old clients, authenticates ownership and fences remote completion');
  await failureChecks(repo, db, projector, { user, desktop, phone, source });
  console.log(`PASS ${checks.length} PostgreSQL guarantees; isolated schema only`);
} finally {
  await observer.query('ROLLBACK').catch(() => undefined);
  await observer.end();
  await db.close();
  // Validated generated identifier owned exclusively by this invocation.
  assert.match(schema, /^hirmos_core_[a-f0-9]{32}$/);
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
}

async function failureChecks(repo, db, projector, {user,desktop,phone,source}) {
  let s;
  const begin = async (ids) => {
    s = await repo.snapshot(user);
    s = (await repo.claim({userId:user,deviceId:desktop,commandId:randomUUID(),expectedRevision:s.revision})).snapshot;
    s = (await repo.selectContext({userId:user,deviceId:desktop,commandId:randomUUID(),expectedRevision:s.revision,
      sourceId:source,remoteTrackIds:ids,selectedIndex:0,contextType:'album',contextRef:'failures'})).snapshot;
  };
  const fault = (code='decode',positionMs=0) => ({userId:user,deviceId:desktop,commandId:randomUUID(),
    expectedRevision:s.revision,anchor:anchor(s),failure:{code,phase:'stream',positionMs,elapsedMs:100}});
  const control = async (action, positionMs) => {
    const result = await repo.control({userId:user,deviceId:desktop,commandId:randomUUID(),expectedRevision:s.revision,
      anchor:anchor(s),action,positionMs});
    assert.equal(result.status,'accepted'); s=result.snapshot;
  };
  await begin(['failed-a','failed-a','healthy-b','failed-c','healthy-d']);
  assert.equal(s.queue.length,4);
  const a = s.currentTrackRef, instance = s.playbackInstanceId, order = structuredClone(s.queue);
  const command = fault('decode',750);
  const failingDb={...db,transaction:run=>db.transaction(connection=>run({...connection,
    query:async(sql,parameters)=>{
      if(sql.includes('INSERT INTO playback_activity_outbox')) throw new Error('failure outbox unavailable');
      return connection.query(sql,parameters);
    },
  }))};
  await assert.rejects(new PlaybackRepository(failingDb).failure(command),/failure outbox unavailable/);
  assert.deepEqual(await repo.snapshot(user),s);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM playback_failures WHERE id=$1',[command.commandId])).rows[0].n,0);
  check('failure record and automatic advance roll back together when durable activity cannot be written');
  assert.equal((await repo.failure({...command,deviceId:phone})).status,'conflict');
  const deliveries = await Promise.all([repo.failure(command),repo.failure(command)]);
  assert.deepEqual(deliveries.map(r=>r.status).sort(),['accepted','duplicate']);
  s = await repo.snapshot(user);
  assert.equal(s.currentQueueItemId,order[1].id);
  assert.deepEqual(s.queue,order);
  assert.equal(s.failures.at(-1).outcome,'advanced');
  assert.ok(Date.parse(s.recoveryDeadline) > Date.now());
  assert.ok(Date.parse(s.recoveryDeadline) <= Date.now() + 30_000);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM playback_failures WHERE id=$1',[command.commandId])).rows[0].n,1);
  assert.equal((await repo.failure({...command,commandId:randomUUID(),expectedRevision:s.revision})).status,'conflict');
  check('one isolated failure advances atomically once in deduplicated order, preserves queue and rejects stale/remote reports');
  while (await projector.runBatch()) { /* drain bounded batches */ }
  const stats = (await db.query(`SELECT play_starts,completions,skips,listened_ms::int FROM user_track_stats
    WHERE user_id=$1 AND remote_track_id='failed-a'`,[user])).rows[0];
  assert.deepEqual(stats,{play_starts:1,completions:0,skips:0,listened_ms:750});
  assert.equal((await db.query('SELECT closed FROM playback_activity_instances WHERE id=$1',[instance])).rows[0].closed,true);
  check('technical skip retains real listening but never contributes dislike or completion');
  s=(await repo.failure(fault())).snapshot;
  s=(await repo.failure(fault())).snapshot;
  assert.equal(s.status,'paused');
  assert.equal(s.renderPhase,'error');
  assert.equal(s.failures.at(-1).outcome,'limit');
  assert.equal(s.currentQueueItemId,order[2].id);
  const stoppedAnchor=anchor(s), stoppedInstance=s.playbackInstanceId;
  await control('pause');
  assert.equal(s.renderPhase,'error');
  assert.equal((await repo.control({userId:user,deviceId:phone,commandId:randomUUID(),expectedRevision:s.revision,
    action:'play',anchor:anchor(s)})).error.code,'RETRY_REQUIRED');
  await control('retry');
  assert.equal(s.recoveryDeadline,null);
  assert.equal(s.playbackInstanceId,stoppedInstance);
  assert.equal(s.attempt,stoppedAnchor.attempt+1);
  assert.equal((await repo.failure({...fault(),anchor:stoppedAnchor})).status,'conflict');
  check('three consecutive failures stop; retry preserves execution with new attempt and fences late errors');

  for (const code of ['authentication','service_unavailable','offline']) {
    await begin([`blocked-${code}`,'other']);
    const item=s.currentQueueItemId;
    s=(await repo.failure(fault(code))).snapshot;
    assert.equal(s.currentQueueItemId,item);
    assert.equal(s.status,'paused'); assert.equal(s.renderPhase,'blocked');
    assert.equal(s.failures.at(-1).outcome,'blocked');
  }
  check('authentication, offline and confirmed service outages never trigger automatic skipping');

  await begin(['permission-only','next']);
  const permissionItem=s.currentQueueItemId, permissionInstance=s.playbackInstanceId;
  const incidentCount=(await db.query('SELECT count(*)::int AS n FROM playback_failures WHERE user_id=$1',[user])).rows[0].n;
  assert.equal((await repo.failure(fault('autoplay'))).status,'conflict');
  const waitCommand=()=>({userId:user,deviceId:desktop,commandId:randomUUID(),expectedRevision:s.revision,
    anchor:anchor(s),leaseEpoch:s.leaseEpoch,status:'paused',renderPhase:'awaiting_interaction',positionMs:s.positionMs});
  const waiting=waitCommand();
  assert.equal((await repo.update({...waiting,deviceId:phone})).status,'conflict');
  assert.equal((await repo.update({...waiting,status:'playing'})).status,'conflict');
  assert.equal((await repo.update({...waiting,positionMs:s.positionMs+1})).status,'conflict');
  const accepted=await repo.update(waiting); assert.equal(accepted.status,'accepted'); s=accepted.snapshot;
  assert.equal((await repo.update(waiting)).status,'duplicate');
  assert.equal(s.renderPhase,'awaiting_interaction'); assert.equal(s.status,'paused');
  assert.equal(s.currentQueueItemId,permissionItem); assert.equal(s.playbackInstanceId,permissionInstance);
  const expiry=s.leaseExpiresAt;
  s=(await repo.update(waitCommand())).snapshot;
  assert.ok(Date.parse(s.leaseExpiresAt)>=Date.parse(expiry));
  assert.equal((await repo.update({...waitCommand(),status:'playing',renderPhase:'playing'})).status,'conflict');
  const failureState=(await db.query('SELECT failure_state FROM playback_sessions WHERE user_id=$1',[user])).rows[0].failure_state;
  assert.equal(failureState.consecutive,0); assert.deepEqual(failureState.omitted,[]);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM playback_failures WHERE user_id=$1',[user])).rows[0].n,incidentCount);
  while(await projector.runBatch()) {}
  assert.equal((await db.query("SELECT count(*)::int AS n FROM user_track_stats WHERE user_id=$1 AND remote_track_id='permission-only'",[user])).rows[0].n,0);
  const staleWait=waitCommand();
  await control('pause');
  assert.equal(s.renderPhase,'paused');
  assert.equal((await repo.update({...staleWait,expectedRevision:s.revision})).status,'conflict');
  assert.equal((await repo.control({userId:user,deviceId:desktop,commandId:randomUUID(),expectedRevision:s.revision,
    anchor:staleWait.anchor,action:'play'})).status,'conflict');
  await control('play');
  s=(await repo.update(waitCommand())).snapshot;
  await control('play');
  assert.equal(s.status,'playing'); assert.equal(s.renderPhase,'loading');
  assert.equal(s.playbackInstanceId,permissionInstance);
  check('permission wait is idempotent, renews lease, never records a failure/listen and fences a concurrent pause');

  await db.query(`UPDATE playback_sessions SET failure_state=jsonb_set(failure_state,'{since}',to_jsonb($2::bigint)) WHERE user_id=$1`,[user,Date.now()-10_000]);
  s=(await repo.update(waitCommand())).snapshot;
  assert.equal(s.recoveryDeadline,null);
  const remaining=(await db.query('SELECT failure_state FROM playback_sessions WHERE user_id=$1',[user])).rows[0].failure_state.permissionBudgetMs;
  assert.ok(remaining>18_000 && remaining<=20_000);
  s=(await repo.update(waitCommand())).snapshot;
  assert.equal((await db.query('SELECT failure_state FROM playback_sessions WHERE user_id=$1',[user])).rows[0].failure_state.permissionBudgetMs,remaining);
  await control('play');
  assert.ok(Date.parse(s.recoveryDeadline)-Date.now()<=remaining);
  assert.ok(Date.parse(s.recoveryDeadline)-Date.now()>remaining-1_000);
  s=(await repo.update(waitCommand())).snapshot;
  const beforeTransfer=waitCommand();
  s=(await repo.claim({userId:user,deviceId:phone,commandId:randomUUID(),expectedRevision:s.revision})).snapshot;
  assert.equal(s.status,'playing'); assert.equal(s.renderPhase,'loading');
  assert.equal((await repo.update({...beforeTransfer,expectedRevision:s.revision})).status,'conflict');
  check('permission waiting freezes recovery budget across heartbeats and transfer fences the previous owner');

  await begin(['buffering','second']);
  const oldExpiry=s.leaseExpiresAt;
  s=(await repo.update({userId:user,deviceId:desktop,commandId:randomUUID(),expectedRevision:s.revision,
    anchor:anchor(s),leaseEpoch:s.leaseEpoch,status:'playing',renderPhase:'buffering',positionMs:0})).snapshot;
  assert.ok(Date.parse(s.leaseExpiresAt)>=Date.parse(oldExpiry));
  assert.equal(s.renderPhase,'buffering');
  while(await projector.runBatch()) {}
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM user_track_stats WHERE user_id=$1 AND remote_track_id='buffering'`,[user])).rows[0].n,0);
  check('buffering heartbeat renews ownership without manufacturing listening events');
  await db.query(`UPDATE playback_sessions SET failure_state=jsonb_set(failure_state,'{since}',to_jsonb($2::bigint)) WHERE user_id=$1`,[user,Date.now()-30_001]);
  s=(await repo.failure(fault('timeout'))).snapshot;
  assert.equal(s.failures.at(-1).outcome,'limit');
  check('elapsed recovery budget stops automatic advances even below three failures');

  await begin(['retry-once','after-retry']);
  const retryInstance=s.playbackInstanceId;
  s=(await repo.failure(fault('service_unavailable',500))).snapshot;
  await control('retry');
  s=(await repo.update({userId:user,deviceId:desktop,commandId:randomUUID(),expectedRevision:s.revision,
    anchor:anchor(s),leaseEpoch:s.leaseEpoch,status:'playing',renderPhase:'playing',positionMs:1000})).snapshot;
  await control('next');
  while(await projector.runBatch()) {}
  const retryStats=(await db.query(`SELECT play_starts,skips,listened_ms::int FROM user_track_stats WHERE user_id=$1 AND remote_track_id='retry-once'`,[user])).rows[0];
  assert.deepEqual(retryStats,{play_starts:1,skips:1,listened_ms:1000});
  assert.notEqual(s.playbackInstanceId,retryInstance);
  check('successful retry does not double-count starts; subsequent deliberate skip remains a user action');
  await begin(['only-failed']);
  s=(await repo.failure(fault())).snapshot;
  assert.equal(s.failures.at(-1).outcome,'end'); assert.equal(s.status,'paused');
  assert.ok(s.failures.length<=10);
  assert.notEqual(s.currentTrackRef,a);
  check('exhausted queue stops without looping and shared incident list stays bounded');
  const failedInstance=s.playbackInstanceId;
  await control('next');
  assert.equal(s.status,'stopped');
  assert.equal(s.renderPhase,'paused');
  await control('play');
  assert.notEqual(s.playbackInstanceId,failedInstance);
  assert.equal(s.recoveryDeadline,null);
  check('manual next beyond the failed final item permits a new execution rather than retrying a closed one');

  await begin(['pause-race','do-not-advance']);
  const pauseItem=s.currentQueueItemId;
  await control('pause');
  const pausedFailure=await repo.failure(fault('decode',700));
  assert.equal(pausedFailure.status,'accepted');
  s=pausedFailure.snapshot;
  assert.equal(s.status,'paused');
  assert.equal(s.currentQueueItemId,pauseItem);
  assert.equal(s.renderPhase,'error');
  assert.equal(s.failures.at(-1).outcome,'paused');
  while(await projector.runBatch()) {}
  const pausedStats=(await db.query(`SELECT play_starts,skips,listened_ms::int FROM user_track_stats WHERE user_id=$1 AND remote_track_id='pause-race'`,[user])).rows[0];
  assert.deepEqual(pausedStats,{play_starts:1,skips:0,listened_ms:700});
  const pausedAttempt=s.attempt;
  await control('retry');
  assert.equal(s.attempt,pausedAttempt+1);
  assert.equal(s.status,'playing');
  check('a failure concurrent with pause is recorded without advancing and an explicit retry can resume');

  await begin(['seek-race','next']);
  const beforeSeek=anchor(s), seekInstance=s.playbackInstanceId;
  await control('seek',15000);
  assert.equal(s.playbackInstanceId,seekInstance);
  assert.equal(s.attempt,beforeSeek.attempt+1);
  assert.equal((await repo.failure({...fault(),anchor:beforeSeek})).status,'conflict');
  assert.equal((await repo.snapshot(user)).positionMs,15000);
  check('a deliberate seek invalidates a late failure without creating another listening execution');

  await begin(['cooldown','next']);
  s=(await repo.failure({...fault('service_unavailable'),failure:{...fault('service_unavailable').failure,retryAfterMs:60000}})).snapshot;
  const tooSoon=await repo.control({userId:user,deviceId:desktop,commandId:randomUUID(),expectedRevision:s.revision,anchor:anchor(s),action:'retry'});
  assert.equal(tooSoon.status,'conflict');
  assert.equal(tooSoon.error.code,'RETRY_LATER');
  check('the durable retry cooldown also applies to another client, not just its UI');
}

async function socketChecks(service, user, other, foreignDevice) {
  const server = createServer();
  const auth = { authenticate: async token => [user, other].includes(token)
    ? { id: `session-${token}`, response: { user: { id: token } } } : null };
  const io = createSocketServer(server, { PUBLIC_ORIGIN: 'http://localhost', NODE_ENV: 'test' }, auth, service);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const clients = [];
  function client(token, protocolVersion, deviceId = randomUUID()) {
    const socket = connectSocket(`http://127.0.0.1:${server.address().port}`, {
      autoConnect: false, reconnection: false, transports: ['websocket'],
      extraHeaders: { cookie: `hirmos_session=${token}` },
      auth: { protocolVersion, deviceId, deviceName: 'Test', deviceType: 'desktop' },
    });
    clients.push(socket);
    return socket;
  }
  async function rejected(socket, message) {
    const result = new Promise(resolve => socket.once('connect_error', resolve));
    socket.connect();
    assert.equal((await timed(result)).message, message);
  }
  try {
    await rejected(client(user, undefined), 'Playback client update required');
    await rejected(client(user, 2), 'Playback client update required');
    await rejected(client('not-authenticated', 2), 'Authentication required');
    await rejected(client(user, 3), 'Playback client update required');
    await rejected(client(user, 4), 'Playback client update required');
    await rejected(client(user, 5, foreignDevice), 'Device unavailable');
    const socket = client(user, 5);
    const initial = new Promise(resolve => socket.once('playback:snapshot', resolve));
    socket.connect();
    const s = await timed(initial);
    const result = await timed(new Promise(resolve => socket.emit('playback:control', {
      commandId: randomUUID(), expectedRevision: s.revision, anchor: anchor(s),
      action: 'next', reason: 'ended', positionMs: 1_000,
      userId: other, deviceId: s.activeDeviceId,
    }, resolve)));
    assert.equal(result.status, 'conflict');
    assert.equal(result.snapshot.sessionId, s.sessionId);
    const paused = await timed(new Promise(resolve => socket.emit('playback:control', {
      commandId: randomUUID(), expectedRevision: result.snapshot.revision, anchor: anchor(result.snapshot),
      action: 'pause', userId: other, deviceId: s.activeDeviceId,
    }, resolve)));
    assert.equal(paused.status, 'accepted');
    assert.equal(paused.snapshot.activeDeviceId, s.activeDeviceId);
    const claimed=await timed(new Promise(resolve=>socket.emit('playback:claim',{
      commandId:randomUUID(),expectedRevision:paused.snapshot.revision,
    },resolve)));
    assert.equal(claimed.status,'accepted');
    const stateEvent=timed(new Promise(resolve=>socket.once('playback:state',resolve)));
    const progress=await timed(new Promise(resolve=>socket.emit('playback:update',{
      commandId:randomUUID(),expectedRevision:claimed.snapshot.revision,anchor:anchor(claimed.snapshot),
      leaseEpoch:claimed.snapshot.leaseEpoch,status:'paused',renderPhase:'paused',positionMs:claimed.snapshot.positionMs,
    },resolve)));
    assert.equal(progress.status,'accepted');assert.equal('queue' in progress.snapshot,false);
    const state=await stateEvent;assert.equal('queue' in state,false);assert.equal(state.queueRevision,claimed.snapshot.queueRevision);
    const full=timed(new Promise(resolve=>socket.once('playback:snapshot',resolve)));
    socket.emit('playback:sync',{lastRevision:state.revision});assert.ok(Array.isArray((await full).queue));
    const remote=client(user,5);
    const remoteInitial=timed(new Promise(resolve=>remote.once('playback:snapshot',resolve)));
    remote.connect();const remoteBefore=await remoteInitial;
    const ownerBroadcast=timed(new Promise(resolve=>socket.once('playback:snapshot',resolve)));
    const repetition=await timed(new Promise(resolve=>remote.emit('playback:repeat',{
      commandId:randomUUID(),expectedRevision:remoteBefore.revision,
      expectedQueueRevision:remoteBefore.queueRevision,expectedRepeatMode:remoteBefore.repeatMode,mode:'all',
      userId:other,deviceId:foreignDevice,
    },resolve)));
    assert.equal(repetition.status,'accepted');assert.equal(repetition.snapshot.repeatMode,'all');
    assert.equal(repetition.snapshot.activeDeviceId,remoteBefore.activeDeviceId);
    assert.equal(repetition.snapshot.playbackInstanceId,remoteBefore.playbackInstanceId);
    assert.equal(repetition.snapshot.positionMs,remoteBefore.positionMs);
    assert.equal((await ownerBroadcast).repeatMode,'all');
  } finally {
    clients.forEach(socket => socket.disconnect());
    await new Promise(resolve => io.close(resolve));
  }
}

async function timed(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Socket test timed out')), 5_000);
    })]);
  } finally { clearTimeout(timer); }
}
