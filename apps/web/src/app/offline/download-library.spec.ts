import { expect,it } from 'vitest';
import { localLibrary,searchTracks } from './download-library';
import type { LocalDownload } from './local-downloads';
import { validPlan, type DownloadPlan } from './download-plans';
const row=(id:string,albumId:string|null='album',artistId:string|null='artist'):LocalDownload=>({
  version:1,owner:'owner',fileId:id,state:'ready',bytes:20,fingerprint:null,contentType:'audio/flac',savedAt:'2026-10-02T00:00:00Z',
  track:{reference:id,title:`Canción ${id}`,album:'Greatest Hits',artist:'Artist',albumId,artistId}});
const plan=(rows:LocalDownload[]):DownloadPlan=>({version:1,owner:'owner',id:'album:album',kind:'album',sourceRef:'album',title:'Album',
  revision:null,requestId:'req',createdAt:'2026-10-02T00:00:00Z',tracks:rows.map(r=>r.track)});
it('groups by identity, not album name, with unknown totals for inferred albums',()=>{
  const result=localLibrary([row('a'),row('b','different')],[]);
  expect(result.albums).toHaveLength(2);expect(result.albums.every(g=>g.total===null&&g.plan===null)).toBe(true);
});
it('a known snapshot shows partial completion; missing rows are not downloaded',()=>{
  const a=row('a'),b={...row('b'),state:'missing' as const};
  const g=localLibrary([a,b],[plan([a,b])]).albums[0];expect(g.ready).toBe(1);expect(g.total).toBe(2);
});
it('legacy metadata can infer album ID from saved album but never invent artist identity',()=>{
  const a=row('a');delete a.track.albumId;delete a.track.artistId;
  const result=localLibrary([a],[plan([a])]);expect(result.albums[0].id).toBe('album');
  expect(result.artists[0].id).toBe('unclassified');
});
it('compilations group one album with multiple artists, not artist/title pseudo albums',()=>{
  const a=row('a'),b=row('b','album','other');b.track.artist='Other';
  const result=localLibrary([a,b],[]);expect(result.albums).toHaveLength(1);expect(result.artists).toHaveLength(2);
  expect(result.albums[0].subtitle).toBe('Varios artistas');
});
it('removed selections are not library playlists or retention references',()=>{
  const a=row('a'),p={...plan([a]),kind:'playlist' as const,removal:'removed' as const};
  expect(localLibrary([a],[p]).playlists).toEqual([]);expect(localLibrary([a],[p]).albums[0].plan).toBeNull();
});
it('extra tracks beyond an old album snapshot invalidate its total, not hide the tracks',()=>{
  const a=row('a'),b=row('b');const g=localLibrary([a,b],[plan([a])]).albums[0];
  expect(g.total).toBeNull();expect(g.tracks).toHaveLength(2);
});
it('search and ordering cover 5000 tracks, independent of any visible page and accents',()=>{
  const rows=Array.from({length:5000},(_,i)=>row(String(i).padStart(4,'0')));
  expect(searchTracks(rows,'cancion 4999','title').map(r=>r.track.reference)).toEqual(['4999']);
  expect(searchTracks(rows,'','title')).toHaveLength(5000);
  expect(searchTracks(rows,'Artist','title').slice(4950)).toHaveLength(50);
});
it('saved ordering is preserved for downloaded playlist snapshots',()=>{
  const rows=[row('z'),row('a'),row('b')];expect(searchTracks(rows,'','saved').map(r=>r.track.reference)).toEqual(['z','a','b']);
});
it('favorites is a named saved list, including incomplete tracks, without changing musical groupings',()=>{
  const a=row('a'),b=row('b');const p:DownloadPlan={...plan([a,b]),kind:'favorites',id:'favorites:favorites',sourceRef:'favorites',title:'Favoritos'};
  const library=localLibrary([a],[p]);
  expect(library.playlists[0]).toMatchObject({id:'favorites',title:'Favoritos',ready:1,total:2});
  expect(library.playlists[0].tracks.map(t=>t.reference)).toEqual(['a','b']);
  expect(library.albums).toHaveLength(1);expect(library.albums[0].total).toBeNull();
});
it('new favorite plans and prior album plans both pass durable index validation',()=>{
  const owner='11111111-1111-4111-8111-111111111111';
  const album={...plan([row('a')]),owner,requestId:crypto.randomUUID()};
  const favorites={...album,kind:'favorites',sourceRef:'favorites',id:'favorites:favorites'};
  expect(validPlan(album,owner)).toBe(true);expect(validPlan(favorites,owner)).toBe(true);
  expect(validPlan({...favorites,sourceRef:'foreign',id:'favorites:foreign'},owner)).toBe(false);
});
