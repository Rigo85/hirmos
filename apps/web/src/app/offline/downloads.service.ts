import { DestroyRef, Injectable, InjectionToken, computed, effect, inject, signal, untracked } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom, fromEvent, takeUntil, timeout } from 'rxjs';
import type { FavoriteDownloadSelection, PlaylistSummary, Track } from '@hirmos/contracts';
import { SessionStore } from '../core/session.store';
import { PlaylistsService } from '../core/playlists.service';
import { browserDownloadStorage } from './browser-download-storage';
import { LocalDownloads, type LocalDownload, type LocalTrack } from './local-downloads';
import { browserPlans, DOWNLOAD_NAMESPACE, type DownloadPlan, type PlanIndex } from './download-plans';
import { DownloadFailure, downloadMessage, downloadOriginal } from './download-transport';

export interface DownloadEnvironment {
  store(owner: string): LocalDownloads;
  plans: PlanIndex;
  source: typeof downloadOriginal;
  metadata?: (references:string[],signal:AbortSignal)=>Promise<Track[]>;
  favorites?: (owner:string,signal:AbortSignal)=>Promise<string[]>;
  extras?: (store:LocalDownloads,row:LocalDownload,signal:AbortSignal,guard:()=>void)=>Promise<void>;
}
export const DOWNLOAD_ENVIRONMENT = new InjectionToken<DownloadEnvironment>('download environment',{
  providedIn:'root',factory:()=>{const http=inject(HttpClient);return {
    store:owner=>new LocalDownloads(owner,browserDownloadStorage()),plans:browserPlans,source:downloadOriginal,
    favorites:async(owner,signal)=>{
      signal.throwIfAborted();
      try {
        const response=await firstValueFrom(http.get<FavoriteDownloadSelection>('/api/library/favorites/download-selection',
          {observe:'response',headers:{'x-hirmos-account-id':owner}}).pipe(timeout(10000),takeUntil(fromEvent(signal,'abort'))));
        if(response.headers.get('x-hirmos-account-id')!==owner)throw new Error('ACCOUNT_CHANGED');
        return response.body!.references;
      }catch(error){
        if(error instanceof HttpErrorResponse)throw new DownloadFailure(['FAVORITES_LIMIT','ACCOUNT_CHANGED'].includes(error.error?.code)?error.error.code:`HTTP_${error.status}`);
        throw error;
      }
    },
    extras:async (...args)=>(await import('./download-extras')).prepareExtras(...args),
    metadata:(references,signal)=>{
      signal.throwIfAborted();
      return firstValueFrom(http.post<{tracks:Track[]}>('/api/music/tracks/resolve',{references})
        .pipe(timeout(10000),takeUntil(fromEvent(signal,'abort')))).then(r=>r.tracks);
    },
  };},
});
export const localTrack = (track: Track): LocalTrack => ({reference:track.id,title:track.title,
  artist:track.artist,album:track.album,durationMs:track.durationMs,
  albumId:track.albumId,artistId:track.artistId,coverUrl:track.coverUrl});
export function uniqueTracks(tracks: LocalTrack[]): LocalTrack[] {
  return [...new Map(tracks.map(track=>[track.reference,track])).values()];
}
export function bytesLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const unit=bytes<1024**2 ? 'KiB' : bytes<1024**3 ? 'MiB' : 'GiB';
  return `${(bytes/1024**(unit==='KiB'?1:unit==='MiB'?2:3)).toFixed(1)} ${unit}`;
}

/** Download work never injects or commands either playback coordinator. */
@Injectable({providedIn:'root'})
export class DownloadsService {
  private readonly session=inject(SessionStore);
  private readonly env=inject(DOWNLOAD_ENVIRONMENT);
  private readonly playlists=inject(PlaylistsService);
  private owner: string | null=null;
  private generation=0;
  private lifetime=new AbortController();
  private active:AbortController|null=null;
  private extrasController:AbortController|null=null;
  private metadataController:AbortController|null=null;
  private favoritesController:AbortController|null=null;
  private readonly extrasCooldown=new Map<string,number>();
  private store:LocalDownloads|null=null;
  private initialized:Promise<void>=Promise.resolve();
  private draining:Promise<void>|null=null;
  private queue:DownloadPlan[]=[];
  private channel:BroadcastChannel|null=null;
  readonly records=signal<LocalDownload[]>([]);
  readonly plans=signal<DownloadPlan[]>([]);
  readonly savedPlans=computed(()=>this.plans().filter(p=>!p.removal));
  readonly libraryState=signal({view:'albums',query:'',sort:'title',page:0,detail:''});
  readonly loading=signal(false);
  readonly error=signal('');
  readonly activePlan=signal<string|null>(null);
  readonly queued=signal<string[]>([]);
  readonly progress=signal<{reference:string;bytes:number;total:number|null}|null>(null);
  readonly usable=signal(false);
  readonly canDownload=computed(()=>this.session.canUseRemote());
  readonly metadataBusy=signal(false);
  readonly favoritesBusy=signal(false);
  readonly extrasBusy=signal(false);
  readonly extrasIssue=signal('');
  readonly extrasResult=signal('');
  readonly extrasProgress=signal('');
  readonly extrasRevision=signal(0);
  readonly legacyCount=computed(()=>this.records().filter(r=>r.state==='ready'&&r.track.albumId===undefined).length);
  readonly ready=computed(()=>new Set(this.records().filter(r=>r.state==='ready').map(r=>r.track.reference)));
  readonly visibleRecords=computed(()=>this.records().filter(r=>r.state!=='deleted'));
  readonly usedBytes=computed(()=>this.visibleRecords().reduce((n,r)=>n+r.bytes,0));

  constructor() {
    effect(()=>{const owner=this.session.localOwner();untracked(()=>this.changeOwner(owner));});
    effect(()=>{if(!this.canDownload())untracked(()=>this.pause());});
    effect(()=>{
      const state=this.libraryState(),owner=this.session.localOwner();
      if(owner&&owner===this.owner)try{localStorage.setItem(`hirmos-download-view:${owner}`,JSON.stringify(state));}catch{/* preferences are optional */}
    });
    if (typeof BroadcastChannel!=='undefined') {
      this.channel=new BroadcastChannel(`${DOWNLOAD_NAMESPACE}:changed`);
      this.channel.onmessage=event=>{if(event.data===this.owner)void this.refresh();};
    }
    const visible=()=>{if(document.visibilityState==='visible')void this.refresh();};
    document.addEventListener('visibilitychange',visible);
    inject(DestroyRef).onDestroy(()=>{this.lifetime.abort();this.active?.abort();this.extrasController?.abort();this.metadataController?.abort();this.favoritesController?.abort();this.channel?.close();document.removeEventListener('visibilitychange',visible);});
  }
  private valid(owner:string,generation:number):boolean {
    return this.owner===owner && this.generation===generation && this.session.localOwner()===owner;
  }
  private changeOwner(owner:string|null):void {
    if(owner===this.owner)return;
    this.lifetime.abort();this.active?.abort();this.extrasController?.abort();this.metadataController?.abort();this.lifetime=new AbortController();
    this.favoritesController?.abort();
    this.extrasIssue.set('');this.extrasProgress.set('');this.extrasResult.set('');
    this.generation++;this.owner=owner;this.store=null;this.queue=[];
    this.queued.set([]);this.activePlan.set(null);this.progress.set(null);
    this.records.set([]);this.plans.set([]);this.error.set('');this.usable.set(false);
    this.libraryState.set({view:'albums',query:'',sort:'title',page:0,detail:''});
    if(owner)try{
      const pref=JSON.parse(localStorage.getItem(`hirmos-download-view:${owner}`)??'null');
      if(pref&&['albums','artists','playlists','tracks'].includes(pref.view)&&['title','artist','album','recent','saved'].includes(pref.sort)
        &&typeof pref.query==='string'&&pref.query.length<1024&&Number.isSafeInteger(pref.page)&&pref.page>=0
        &&typeof pref.detail==='string'&&pref.detail.length<2100)this.libraryState.set(pref);
    }catch{/* old or unavailable preferences do not affect downloads */}
    const generation=this.generation;
    if(!owner){this.loading.set(false);return;}
    this.loading.set(true);
    this.initialized=(async()=>{
      try {
        const store=this.env.store(owner);
        await this.resumeRemovals(store,owner,this.lifetime.signal);
        const [state,plans]=await Promise.all([store.reconcile(false,this.lifetime.signal),this.env.plans.list(owner)]);
        if(!this.valid(owner,generation))return;
        this.store=store;this.records.set(state.records);this.plans.set(plans);this.usable.set(true);
      }catch(error){if(this.valid(owner,generation))this.error.set(downloadMessage(error));}
      finally{if(this.valid(owner,generation))this.loading.set(false);}
    })();
  }
  async refresh(audit=false):Promise<void> {
    if(this.loading())return;
    const owner=this.owner, generation=this.generation, store=this.store;
    if(!owner||!store)return;
    this.loading.set(true);
    try {
      if(!this.activePlan())await this.resumeRemovals(store,owner,this.lifetime.signal);
      const [state,plans]=await Promise.all([this.activePlan()?store.list().then(records=>({records})):store.reconcile(audit,this.lifetime.signal),this.env.plans.list(owner)]);
      if(this.valid(owner,generation)){this.records.set(state.records);this.plans.set(plans);this.error.set('');}
    }catch(error){if(this.valid(owner,generation))this.error.set(downloadMessage(error));}
    finally{if(this.valid(owner,generation))this.loading.set(false);}
  }
  async enqueue(tracks:Track[],kind:'track'|'album'='track',sourceRef?:string,title?:string):Promise<void> {
    const owner=this.session.session()?.user.id;
    if(!owner||!this.canDownload())throw new Error('HTTP_401');
    this.changeOwner(owner); const generation=this.generation; await this.initialized;
    if(!this.store||!this.valid(owner,generation))throw new Error('ACCOUNT_CHANGED');
    const clean=uniqueTracks(tracks.map(localTrack));
    if(!clean.length||clean.length>5000)throw new Error('INVALID_PLAN');
    if(kind==='track' && clean.length>1) {
      // Individual selections remain individual; no anonymous pseudo-album.
      for(const track of clean) {
        if(!this.valid(owner,generation))throw new Error('ACCOUNT_CHANGED');
        await this.savePlan({version:1,owner,kind,sourceRef:track.reference,
          id:`track:${track.reference}`,title:track.title,revision:null,
          createdAt:new Date().toISOString(),requestId:crypto.randomUUID(),tracks:[track]});
      }
      return;
    }
    await this.savePlan({version:1,owner,kind,sourceRef:sourceRef??clean[0]!.reference,
      id:`${kind}:${sourceRef??clean[0]!.reference}`,title:title??clean[0]!.title,
      revision:null,createdAt:new Date().toISOString(),requestId:crypto.randomUUID(),tracks:clean});
  }
  async enqueuePlaylist(summary:PlaylistSummary):Promise<void> {
    const owner=this.session.session()?.user.id;
    if(!owner||!this.canDownload())throw new Error('HTTP_401');
    this.changeOwner(owner);await this.initialized;
    const generation=this.generation;
    const tracks:Track[]=[];let offset:number|null=0;const seen=new Set<number>();
    const deadline=Date.now()+60000;
    while(offset!==null) {
      if(!this.valid(owner,generation))throw new Error('ACCOUNT_CHANGED');
      if(seen.has(offset)||Date.now()>deadline)throw new Error('TIMEOUT');seen.add(offset);
      const page=await this.playlists.page(summary.id,offset,summary.revision);
      if(page.playlist.revision!==summary.revision)throw new DownloadFailure('PLAYLIST_CHANGED');
      if(page.items.some(i=>i.availability!=='available'))throw new DownloadFailure('PLAYLIST_UNAVAILABLE');
      tracks.push(...page.items.map(i=>i.track));
      if(tracks.length>5000)throw new Error('INVALID_PLAN');offset=page.nextOffset;
    }
    if(!this.valid(owner,generation))throw new Error('ACCOUNT_CHANGED');
    if(tracks.length!==summary.count||!tracks.length)throw new DownloadFailure('PLAYLIST_CHANGED');
    await this.savePlan({version:1,owner,kind:'playlist',sourceRef:summary.id,id:`playlist:${summary.id}`,
      title:summary.name,revision:summary.revision,createdAt:new Date().toISOString(),requestId:crypto.randomUUID(),tracks:uniqueTracks(tracks.map(localTrack))});
  }
  async enqueueFavorites():Promise<void> {
    if(this.favoritesBusy())return;
    if(this.activePlan()==='favorites:favorites'||this.queued().includes('favorites:favorites'))throw new Error('FAVORITES_BUSY');
    const owner=this.session.session()?.user.id;
    if(!owner||!this.canDownload())throw new Error('HTTP_401');
    this.changeOwner(owner);const generation=this.generation;
    const controller=new AbortController();this.favoritesController=controller;this.favoritesBusy.set(true);
    const timer=setTimeout(()=>controller.abort(new DOMException('Timed out','TimeoutError')),60000);
    const guard=()=>{
      controller.signal.throwIfAborted();
      if(!this.valid(owner,generation)||!this.canDownload()||this.session.session()?.user.id!==owner)throw new Error('ACCOUNT_CHANGED');
    };
    try {
      await this.initialized;guard();
      if(!this.env.favorites||!this.env.metadata)throw new Error('UNSUPPORTED');
      const refs=await this.env.favorites(owner,controller.signal);guard();
      if(!Array.isArray(refs)||refs.some(r=>typeof r!=='string'||!/^[A-Za-z0-9_-]{1,2048}$/.test(r))||new Set(refs).size!==refs.length)throw new Error('INVALID_PLAN');
      if(!refs.length)throw new Error('FAVORITES_EMPTY');
      if(refs.length>5000)throw new Error('FAVORITES_LIMIT');
      const tracks:Track[]=[];
      for(let offset=0;offset<refs.length;offset+=50){
        guard();const batch=refs.slice(offset,offset+50);
        const resolved=await this.env.metadata(batch,controller.signal);guard();
        const byId=new Map(resolved.map(t=>[t.id,t]));
        if(resolved.length!==batch.length||byId.size!==batch.length||batch.some(id=>!byId.has(id)))throw new Error('FAVORITES_UNAVAILABLE');
        tracks.push(...batch.map(id=>byId.get(id)!));
      }
      guard();
      await this.savePlan({version:1,owner,kind:'favorites',id:'favorites:favorites',sourceRef:'favorites',title:'Favoritos',
        revision:null,createdAt:new Date().toISOString(),requestId:crypto.randomUUID(),tracks:tracks.map(localTrack)},guard);
    }finally{
      clearTimeout(timer);if(this.favoritesController===controller){this.favoritesController=null;this.favoritesBusy.set(false);}
    }
  }
  private async savePlan(plan:DownloadPlan,guard?:()=>void):Promise<void> {
    const generation=this.generation;
    if(!this.store||!this.valid(plan.owner,generation))throw new Error('ACCOUNT_CHANGED');
    plan.retryAt=Math.max(plan.retryAt??0,...this.plans().map(p=>p.retryAt??0));
    await this.store.mutate(async()=>{
      guard?.();
      if(!this.valid(plan.owner,generation))throw new Error('ACCOUNT_CHANGED');
      const existing=await this.env.plans.list(plan.owner),previous=existing.find(p=>p.id===plan.id);
      guard?.();
      const nextRefs=new Set(plan.tracks.map(t=>t.reference));
      const retainedIds=new Set(existing.filter(p=>!p.removal).map(p=>p.id));
      if(previous?.removal==='removing')throw new Error('PLAN_CHANGED');
      // Tracks dropped by an explicitly refreshed snapshot remain visible and retained.
      for(const track of previous?.tracks??[]) {
        if(previous?.removal || nextRefs.has(track.reference))continue;
        const id=`track:${track.reference}`;
        guard?.();if(!retainedIds.has(id))await this.env.plans.put({
          version:1,owner:plan.owner,id,kind:'track',sourceRef:track.reference,title:track.title,
          revision:null,createdAt:plan.createdAt,requestId:crypto.randomUUID(),tracks:[track]});
      }
      guard?.();await this.env.plans.put(plan);
    });
    if(!this.valid(plan.owner,generation))return;
    const plans=await this.env.plans.list(plan.owner);
    if(!this.valid(plan.owner,generation))return;
    this.plans.set(plans);
    this.channel?.postMessage(plan.owner);this.start(plan);
  }
  start(plan:DownloadPlan):void {
    if(!this.canDownload()){this.error.set('Renueva el acceso online y vuelve a intentar la descarga.');return;}
    if(plan.removal||!this.owner||plan.owner!==this.owner||this.session.session()?.user.id!==this.owner||!this.store)return;
    if(Math.max(plan.retryAt??0,...this.plans().map(p=>p.retryAt??0))>Date.now()) {this.error.set('El servicio pidió esperar. Reintenta después del plazo indicado.');return;}
    if(this.activePlan()===plan.id||this.queue.some(p=>p.id===plan.id))return;
    this.extrasController?.abort(new DOMException('Audio takes priority','AbortError'));
    this.error.set('');this.queue.push(plan);this.queued.set(this.queue.map(p=>p.id));this.kick();
  }
  pause():void {
    this.queue=[];this.queued.set([]);this.active?.abort(new DOMException('Paused','AbortError'));
    this.extrasController?.abort(new DOMException('Paused','AbortError'));
    this.metadataController?.abort(new DOMException('Paused','AbortError'));
    this.favoritesController?.abort(new DOMException('Paused','AbortError'));
  }
  private kick():void {
    if(this.draining||!this.queue.length)return;
    this.draining=this.drain().finally(()=>{this.draining=null;if(this.queue.length)this.kick();});
  }
  private async drain():Promise<void> {
    const owner=this.owner,initialGeneration=this.generation;
    const prepared=new Set<string>();
    let interrupted=false;
    while(this.queue.length) {
      const plan=this.queue.shift()!, generation=this.generation, store=this.store;
      if(!store||!this.valid(plan.owner,generation)||!this.canDownload())continue;
      this.queued.set(this.queue.map(p=>p.id));this.activePlan.set(plan.id);
      const controller=new AbortController();this.active=controller;
      let lastIssue='';let retryAt=0;let failedReference:string|undefined;
      try {
        const latest=(await this.env.plans.list(plan.owner)).find(p=>p.id===plan.id);
        if(latest?.requestId!==plan.requestId)throw new Error('PLAN_CHANGED');
        for(const track of plan.tracks) {
          if(!this.valid(plan.owner,generation)||!this.canDownload())break;
          controller.signal.throwIfAborted();
          let lastUpdate=0;
          this.progress.set({reference:track.reference,bytes:0,total:null});
          try {
            await store.save(track,'application/octet-stream',null,()=>this.env.source(track.reference,plan.owner,controller.signal,(bytes,total)=>{
              if(this.valid(plan.owner,generation)&&(bytes===0||bytes===total||Date.now()-lastUpdate>150)){
                lastUpdate=Date.now();this.progress.set({reference:track.reference,bytes,total});
              }
            }),controller.signal,async()=>{
              if(!this.valid(plan.owner,generation)||!this.canDownload())throw new Error('ACCOUNT_CHANGED');
              const current=(await this.env.plans.list(plan.owner)).find(p=>p.id===plan.id);
              if(!current || current.removal || current.requestId!==plan.requestId)throw new Error('PLAN_CHANGED');
            });
            prepared.add(track.reference);
          }catch(error){
            if(controller.signal.aborted)throw error;
            if(error instanceof DownloadFailure&&error.code==='HTTP_401')this.session.requireRenewal();
            lastIssue=downloadMessage(error);retryAt=error instanceof DownloadFailure?error.retryAt:0;failedReference=track.reference;
            this.queue=[];this.queued.set([]);break; // Global/unknown failure must not walk a 5k playlist.
          }finally{
            const rows=await store.list();if(this.valid(plan.owner,generation))this.records.set(rows);
          }
        }
      }catch(error){if(!controller.signal.aborted)lastIssue=downloadMessage(error);}
      finally {
        if(controller.signal.aborted||lastIssue)interrupted=true;
        if(this.valid(plan.owner,generation)) {
          const updated={...plan,lastIssue,retryAt,failedReference};
          try{await this.env.plans.finish(updated);const plans=await this.env.plans.list(plan.owner);if(this.valid(plan.owner,generation))this.plans.set(plans);}
          catch(error){if(this.valid(plan.owner,generation))this.error.set(downloadMessage(error));}
          if(this.valid(plan.owner,generation)){this.progress.set(null);this.activePlan.set(null);this.channel?.postMessage(plan.owner);}
        }
        if(this.active===controller)this.active=null;
      }
    }
    // Audio is committed before optional auxiliary work starts. A provider outage
    // cannot invalidate completed audio or stall downloading the rest of a plan.
    if(!interrupted&&owner&&this.valid(owner,initialGeneration)&&prepared.size)await this.prepareAuxiliaries(prepared);
  }
  async prepareAuxiliaries(references?:Set<string>):Promise<void> {
    const owner=this.owner,generation=this.generation,store=this.store;
    if(!owner||!store||!this.canDownload()||!this.env.extras||this.extrasBusy())return;
    if((this.extrasCooldown.get(owner)??0)>Date.now()){
      this.extrasIssue.set('El servicio pidió esperar antes de preparar portadas y letras. Tus archivos se conservan.');return;
    }
    const controller=new AbortController();this.extrasController=controller;
    const guard=()=>{if(!this.valid(owner,generation)||!this.canDownload())throw new Error('ACCOUNT_CHANGED');};
    this.extrasBusy.set(true);this.extrasIssue.set('');this.extrasResult.set('');
    try {
      const rows=this.records().filter(r=>r.state==='ready'&&(!references||references.has(r.track.reference)));
      for(let i=0;i<rows.length;i++){
        guard();controller.signal.throwIfAborted();
        this.extrasProgress.set(`${i+1} de ${rows.length} · ${rows[i].track.title}`);
        await this.env.extras(store,rows[i],controller.signal,guard);
        if(this.valid(owner,generation))this.extrasRevision.update(n=>n+1);
      }
      guard();controller.signal.throwIfAborted();
      this.extrasResult.set(`Preparación terminada: ${rows.length} canciones revisadas. Se conservó lo disponible; no todas las canciones tienen portada o letra.`);
    }catch(error){
      if(!controller.signal.aborted&&this.valid(owner,generation)){
        this.extrasIssue.set('No pudimos completar las portadas y letras. El audio descargado sigue disponible; puedes volver a prepararlas online.');
        if(error instanceof DownloadFailure&&error.retryAt>Date.now())this.extrasCooldown.set(owner,error.retryAt);
        if(error instanceof DownloadFailure&&error.code==='HTTP_401')this.session.requireRenewal();
      }
    }finally{
      if(this.extrasController===controller){this.extrasController=null;this.extrasBusy.set(false);this.extrasProgress.set('');}
    }
  }
  async remove(reference:string,expectedOwner?:string):Promise<void> {
    const owner=this.owner,generation=this.generation,store=this.store;
    if(expectedOwner&&expectedOwner!==owner)throw new Error('ACCOUNT_CHANGED');
    if(!owner||!store||!this.valid(owner,generation))return;
    this.pause();await this.draining;
    if(!this.valid(owner,generation))return;
    try {
      await store.mutate(async remove=>{
        if(!this.valid(owner,generation))throw new Error('ACCOUNT_CHANGED');
        for(const plan of await this.env.plans.list(owner))if(!plan.removal&&plan.tracks.some(t=>t.reference===reference)) {
          await this.env.plans.put({...plan,requestId:crypto.randomUUID()});
        }
        await remove(reference);
      });
      await this.refresh();this.channel?.postMessage(owner);
    }
    catch(error){if(this.valid(owner,generation)){this.error.set(downloadMessage(error));throw error;}}
  }
  completed(plan:DownloadPlan):number {return plan.tracks.filter(t=>this.ready().has(t.reference)).length;}
  async updateLegacyMetadata():Promise<void> {
    if(!this.canDownload())return;
    const owner=this.owner,generation=this.generation,store=this.store;
    if(!owner||!store||!this.env.metadata||this.metadataBusy())return;
    const controller=new AbortController();this.metadataController=controller;
    this.metadataBusy.set(true);this.error.set('');
    try {
      const refs=this.records().filter(r=>r.state==='ready'&&r.track.albumId===undefined).map(r=>r.track.reference);
      for(let i=0;i<refs.length;i+=100){
        if(controller.signal.aborted||!this.valid(owner,generation)||!this.canDownload())return;
        const batch=refs.slice(i,i+100),tracks=await this.env.metadata(batch,controller.signal);
        // A response can race a mode/access change, even if transport cancellation wins late.
        if(controller.signal.aborted||!this.valid(owner,generation)||!this.canDownload())return;
        await store.updateMetadata(tracks.filter(t=>batch.includes(t.id)).map(localTrack),controller.signal);
        if(batch.some(ref=>!tracks.some(t=>t.id===ref)))throw new Error('METADATA_INCOMPLETE');
      }
      await this.refresh();
    }catch(error){
      if(!controller.signal.aborted&&this.valid(owner,generation)&&this.canDownload()){
        await this.refresh();
        if(!controller.signal.aborted&&this.valid(owner,generation)&&this.canDownload())this.error.set(downloadMessage(error));
      }
    }
    finally{if(this.metadataController===controller){this.metadataController=null;this.metadataBusy.set(false);}}
  }
  exclusiveReferences(plan:DownloadPlan):string[] {
    const kept=new Set(this.savedPlans().filter(p=>p.id!==plan.id).flatMap(p=>p.tracks.map(t=>t.reference)));
    return plan.tracks.filter(t=>!kept.has(t.reference)).map(t=>t.reference);
  }
  async removePlan(plan:DownloadPlan):Promise<void> {
    const owner=this.owner,generation=this.generation,store=this.store;
    if(!owner||!store||plan.owner!==owner||!this.valid(owner,generation))throw new Error('ACCOUNT_CHANGED');
    this.pause();await this.draining;
    await store.mutate(async()=>{
      if(!this.valid(owner,generation))throw new Error('ACCOUNT_CHANGED');
      const current=(await this.env.plans.list(owner)).find(p=>p.id===plan.id);
      if(!current||current.removal)return;
      if(current.requestId!==plan.requestId)throw new Error('PLAN_CHANGED');
      await this.env.plans.put({...current,removal:'removing',requestId:crypto.randomUUID()});
    });
    await this.resumeRemovals(store,owner);
    await this.refresh();this.channel?.postMessage(owner);
  }
  private async resumeRemovals(store:LocalDownloads,owner:string,signal?:AbortSignal):Promise<void> {
    await store.mutate(async remove=>{
      const plans=await this.env.plans.list(owner);
      const kept=new Set(plans.filter(p=>!p.removal).flatMap(p=>p.tracks.map(t=>t.reference)));
      for(const plan of plans.filter(p=>p.removal==='removing')) {
        for(const track of plan.tracks){signal?.throwIfAborted();if(!kept.has(track.reference))await remove(track.reference);}
        await this.env.plans.put({...plan,removal:'removed'});
      }
    },signal);
  }
  issueFor(reference:string):string {return this.plans().find(p=>p.failedReference===reference&&p.lastIssue)?.lastIssue??'';}
  async retry(row:LocalDownload):Promise<void> {
    if(row.owner!==this.owner)return;
    await this.savePlan({version:1,owner:row.owner,id:`track:${row.track.reference}`,kind:'track',
      sourceRef:row.track.reference,title:row.track.title,revision:null,createdAt:new Date().toISOString(),requestId:crypto.randomUUID(),tracks:[row.track]});
  }
}
