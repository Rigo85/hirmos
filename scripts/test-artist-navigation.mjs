// Integration tests use a fresh schema in the disposable local test database.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import pg from 'pg';
import { createDatabase } from '../apps/api/dist/db/database.js';
import { ActivityRepository } from '../apps/api/dist/activity/activity-repository.js';
import { CatalogRepository } from '../apps/api/dist/activity/catalog-repository.js';
import { MusicSourceService } from '../apps/api/dist/music-source/music-source-service.js';
import { encodeTrackReference } from '../apps/api/dist/music-source/track-reference.js';

const url = new URL(process.env.HIRMOS_TEST_DATABASE_URL ?? '');
assert.ok(['localhost', '127.0.0.1'].includes(url.hostname) && url.pathname === '/hirmos_core_test');
const admin = new pg.Client({ connectionString: url.href });
await admin.connect();
const schema = `hirmos_artist_${randomUUID().replaceAll('-', '')}`;
await admin.query(`CREATE SCHEMA ${schema}`);
url.searchParams.set('options', `-c search_path=${schema} -c statement_timeout=10000`);
const db = createDatabase(url.href);
let count = 0;
const pass = message => { count++; console.log(`PASS ${message}`); };
try {
  for (const file of (await readdir(new URL('../database/migrations/', import.meta.url))).filter(f => f.endsWith('.sql')).sort()) {
    await db.query(await readFile(new URL(`../database/migrations/${file}`, import.meta.url), 'utf8'));
  }
  const repo = new CatalogRepository(db);
  const newSource = async () => (await db.query(`INSERT INTO music_sources(name,adapter_type,base_url,credential_ciphertext,encryption_key_version,enabled)
    VALUES('Synthetic','navidrome','https://music.example.test',decode('00','hex'),1,false) RETURNING id`)).rows[0].id;
  const source = await newSource(), otherSource = await newSource();
  const album = (id, artistId) => ({ id, name:id, artist:artistId, artistId, coverArtId:null, songCount:99, durationMs:1000, year:2026, genres:[] });
  const track = (id, artistId, albumId='record') => ({id,title:'Same title',artist:artistId,artistId,album:albumId,albumId,durationMs:1000,coverArtId:null,year:2026,genres:[]});
  const detail = (id, albums=[]) => ({id,name:id,coverArtId:null,albumCount:albums.length,albums,biography:`Bio ${id}`,externalUrl:null,similarArtists:[],topTracks:[]});
  const first = await repo.beginSync(source);
  await repo.observeArtistDetail(source,{...detail('primary',[album('record','primary')]),topTracks:[track('two','primary')]});
  await repo.observeArtistDetail(source,detail('alias'));
  await repo.observeArtistDetail(source,detail('homonym'));
  await repo.observeAlbums(source,[album('compilation','various')]);
  await repo.observeTracks(source,[track('one','alias'),track('two','primary'),track('guest','guest','compilation'),track('solo','track-only')]);
  await repo.finishSync({...first,sourceId:source,artists:3,albums:2,tracks:4});
  const canonical = (await db.query(`INSERT INTO canonical_artists(display_name) VALUES ('Confirmed identity') RETURNING id`)).rows[0].id;
  await db.query(`INSERT INTO canonical_artist_members(canonical_artist_id,source_id,remote_artist_id,linked_by,preferred_for_navigation)
    VALUES ($1,$2,'primary','manual',true),($1,$2,'alias','manual',false),($1,$3,'elsewhere','manual',true)`,[canonical,source,otherSource]);
  assert.deepEqual(await repo.artistIdentity(source,'alias'),{preferredId:'primary',memberIds:['alias','primary']});
  assert.deepEqual(await repo.artistIdentity(source,'homonym'),{preferredId:'homonym',memberIds:['homonym']});
  assert.deepEqual(await repo.artistIdentity(otherSource,'alias'),{preferredId:'alias',memberIds:['alias']});
  await assert.rejects(db.query(`UPDATE canonical_artist_members SET preferred_for_navigation=true WHERE source_id=$1 AND remote_artist_id='alias'`,[source]));
  pass('confirmed members and preference are source scoped; homonyms stay separate; unique preference enforced');
  const library=await repo.artistLibrary(source,['alias','primary']);
  assert.equal(library.songCount,2);assert.deepEqual(library.albums.map(a=>a.id),['record']);
  const guest=await repo.artistLibrary(source,['guest']);
  assert.equal(guest.songCount,1);assert.deepEqual(guest.albums,[]);
  assert.equal(await repo.artistLibrary(otherSource,['elsewhere']),null);
  pass('counts unique track IDs, not album sizes or titles; guest does not own compilation; incomplete catalog is unknown');
  const sourceRecord={id:source,adapterType:'navidrome',baseUrl:'https://music.example.test'};
  const service=new MusicSourceService({current:async()=>sourceRecord}, {}, {create:()=>{throw Error('Cached artist should not request provider');}},undefined,undefined,undefined,repo);
  const firstDetail=await service.artist('user',encodeTrackReference(source,'alias'));
  const secondDetail=await service.artist('user',encodeTrackReference(source,'primary'));
  await assert.rejects(service.artist('user',encodeTrackReference(otherSource,'primary')));
  assert.deepEqual(firstDetail,secondDetail);assert.equal(firstDetail.biography,'Bio primary');assert.equal(firstDetail.songCount,2);
  await service.artistGenreTags(encodeTrackReference(source,'alias'));
  pass('both direct URLs resolve identical cached detail and genres without provider traffic');
  const user=(await db.query("INSERT INTO users(email,display_name,role) VALUES ('listener@example.test','Synthetic','user') RETURNING id")).rows[0].id;
  await db.query(`INSERT INTO user_track_stats(user_id,source_id,remote_track_id,play_starts,listened_ms)
    VALUES ($1,$2,'guest',1,1000)`,[user,source]);
  const activity = new ActivityRepository(db);
  const habits = new MusicSourceService({current:async()=>sourceRecord}, {decrypt:()=>({})}, {create:()=>({})},activity,undefined,undefined,repo);
  const habitAlbums=(await habits.habits(user,'albums','all',10)).albums;
  assert.equal(habitAlbums[0].artist,'various');
  assert.equal(habitAlbums[0].artistId,encodeTrackReference(source,'various'));
  assert.deepEqual((await habits.habits(randomUUID(),'albums','all',10)).albums,[]);
  pass('album habits link to album artist, not guest; activity remains user scoped');

  await repo.observeArtistDetail(source,{...detail('primary'),externalInfoAvailable:false,topTracksAvailable:false});
  assert.equal((await repo.artistDetail(source,'primary')).detail.biography,'Bio primary');
  assert.equal((await repo.artistDetail(source,'primary')).detail.topTracks[0].id,'two');
  // Two successful scans omit track-only artists from the artist index but see their tracks.
  for(let i=0;i<2;i++) {
    await db.query(`UPDATE catalog_artists SET last_seen_at=now()-interval '1 day' WHERE source_id=$1`,[source]);
    const scan=await repo.beginSync(source);
    await repo.observeTracks(source,[track('one','alias'),track('two','primary'),track('solo','track-only')]);
    await repo.observeAlbums(source,[album('record','primary')]);
    await repo.finishSync({...scan,sourceId:source,artists:0,albums:1,tracks:3});
  }
  const active=await db.query(`SELECT remote_artist_id FROM catalog_artists WHERE source_id=$1 AND missing_since IS NULL`,[source]);
  assert.ok(active.rows.some(a=>a.remote_artist_id==='alias'));assert.ok(active.rows.some(a=>a.remote_artist_id==='track-only'));
  assert.ok(!active.rows.some(a=>a.remote_artist_id==='homonym'));
  pass('successful sync preserves referenced artists (including new track-only rows), removes truly absent ones');
  const failed=await repo.beginSync(source);await repo.failSync(failed.id,'synthetic');
  assert.ok(await repo.artistDetail(source,'alias'));
  // Old cached references are not fresh scan evidence.
  await db.query(`UPDATE catalog_tracks SET last_seen_at=now()-interval '1 day' WHERE source_id=$1`,[source]);
  await db.query(`UPDATE catalog_albums SET last_seen_at=now()-interval '1 day' WHERE source_id=$1`,[source]);
  await db.query(`UPDATE catalog_artists SET last_seen_at=now()-interval '1 day' WHERE source_id=$1`,[source]);
  for(let i=0;i<2;i++) {const scan=await repo.beginSync(source);await repo.finishSync({...scan,sourceId:source,artists:0,albums:0,tracks:0});}
  assert.equal(await repo.artistDetail(source,'alias'),null);
  assert.equal((await repo.artistLibrary(source,['alias','primary'])).songCount,0);
  pass('failed scan does not retire artists; historical references do not prevent real retirement');
  console.log(`${count} artist integration groups passed`);
} finally {
  await db.close();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();
}
