import type { LocalDownload, LocalTrack } from './local-downloads';
import type { DownloadPlan } from './download-plans';

export interface DownloadGroup {
  id:string;title:string;subtitle:string;kind:'album'|'artist'|'playlist';
  tracks:LocalTrack[];ready:number;total:number|null;plan:DownloadPlan|null;coverUrl:string|null;savedAt:string;
}
export const normalizeSearch=(text:string)=>text.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLocaleLowerCase();
export function localLibrary(records:LocalDownload[],plans:DownloadPlan[]):{albums:DownloadGroup[];artists:DownloadGroup[];playlists:DownloadGroup[]} {
  const active=plans.filter(p=>!p.removal),ready=new Set(records.filter(r=>r.state==='ready').map(r=>r.track.reference));
  const dates=new Map(records.map(r=>[r.track.reference,r.savedAt]));
  const metadata=new Map<string,LocalTrack>();
  for(const p of active)for(const t of p.tracks)metadata.set(t.reference,{...metadata.get(t.reference),...t,
    albumId:t.albumId??(p.kind==='album'?p.sourceRef:metadata.get(t.reference)?.albumId)});
  const tracks=records.filter(r=>r.state==='ready').map(r=>({...metadata.get(r.track.reference),...r.track,
    albumId:r.track.albumId??metadata.get(r.track.reference)?.albumId}));
  const group=(kind:'album'|'artist'):DownloadGroup[]=>{
    const groups=new Map<string,DownloadGroup>();
    for(const track of tracks) {
      const reference=kind==='album'?track.albumId:track.artistId;
      // Unknown IDs stay explicit. Never merge albums/artists merely by display name.
      const id=reference??'unclassified';
      let g=groups.get(id);
      if(!g){g={id,title:reference?(kind==='album'?track.album:track.artist):'Sin identificar',
        subtitle:reference&&kind==='album'?track.artist:'',kind,tracks:[],ready:0,total:null,
        plan:kind==='album'?active.find(p=>p.kind==='album'&&p.sourceRef===reference)??null:null,
        coverUrl:kind==='album'?track.coverUrl??null:null,savedAt:''};groups.set(id,g);}
      g.tracks.push(track);g.ready++;
      const saved=dates.get(track.reference)??'';if(saved>g.savedAt)g.savedAt=saved;
    }
    for(const g of groups.values()) {
      if(g.plan){
        const known=new Map(g.plan.tracks.map(t=>[t.reference,t]));
        for(const t of g.tracks)known.set(t.reference,t);
        g.tracks=[...known.values()];
        // A stale snapshot with extra saved tracks no longer proves the album total.
        g.total=g.tracks.length===g.plan.tracks.length?g.plan.tracks.length:null;
      }
      if(kind==='album'&&new Set(g.tracks.map(t=>t.artist)).size>1)g.subtitle='Varios artistas';
    }
    return [...groups.values()];
  };
  const albums=group('album');
  for(const p of active.filter(p=>p.kind==='album'))if(!albums.some(a=>a.id===p.sourceRef))albums.push({
    id:p.sourceRef,title:p.title,subtitle:p.tracks[0]?.artist??'',kind:'album',tracks:p.tracks,
    ready:0,total:p.tracks.length,plan:p,coverUrl:p.tracks.find(t=>t.coverUrl)?.coverUrl??null,savedAt:p.createdAt});
  return {albums,artists:group('artist'),playlists:active.filter(p=>p.kind==='playlist'||p.kind==='favorites').map(p=>({
    id:p.sourceRef,title:p.title,subtitle:p.kind==='favorites'?'Favoritos guardados · actualización manual':'Selección guardada',kind:'playlist',tracks:p.tracks,
    ready:p.tracks.filter(t=>ready.has(t.reference)).length,total:p.tracks.length,plan:p,
    coverUrl:p.tracks.find(t=>t.coverUrl)?.coverUrl??null,savedAt:p.createdAt}))};
}
export function searchTracks(tracks:LocalDownload[],query:string,sort:string):LocalDownload[] {
  const q=normalizeSearch(query.trim());
  return tracks.filter(r=>normalizeSearch(`${r.track.title} ${r.track.artist} ${r.track.album}`).includes(q)).sort((a,b)=>{
    if(sort==='saved')return 0;
    const result=sort==='recent'?b.savedAt.localeCompare(a.savedAt):sort==='artist'?a.track.artist.localeCompare(b.track.artist):
      sort==='album'?a.track.album.localeCompare(b.track.album):a.track.title.localeCompare(b.track.title);
    return result||a.track.title.localeCompare(b.track.title)||a.track.reference.localeCompare(b.track.reference);
  });
}
