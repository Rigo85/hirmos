import { DestroyRef, Injectable, InjectionToken, computed, effect, inject, signal, untracked } from '@angular/core';
import type { Track } from '@hirmos/contracts';
import { AudioPlayerService } from '../core/audio-player.service';
import { MediaSessionService } from '../core/media-session.service';
import { SessionStore } from '../core/session.store';
import { browserDownloadStorage, downloadIndex } from './browser-download-storage';
import { DOWNLOAD_NAMESPACE } from './download-plans';
import { LocalDownloads, type LocalTrack } from './local-downloads';
import { editOfflineQueue, emptyOfflineQueue, nextOfflineReference, readOfflineQueue, shuffledReferences, type OfflineQueue, type OfflineQueueEdit } from './offline-queue';
import { ListenMeter } from './listen-meter';
import { OfflineListenRecorder } from './offline-listens.service';

export interface OfflinePlaybackEnvironment {
  files(owner:string):Pick<LocalDownloads,'openAudio'>;
  read(owner:string):Promise<unknown>;
  save(state:OfflineQueue):Promise<void>;
  claim(owner:string):Promise<(()=>void)|null>;
  url(file:Blob):string;
  revoke(url:string):void;
}
export const OFFLINE_PLAYBACK_ENVIRONMENT=new InjectionToken<OfflinePlaybackEnvironment>('offline playback environment',{
  providedIn:'root',factory:()=>({
    files:owner=>new LocalDownloads(owner,browserDownloadStorage()),
    read:owner=>downloadIndex(DOWNLOAD_NAMESPACE,'readonly',s=>s.get(owner),'playback'),
    save:async state=>{await downloadIndex(DOWNLOAD_NAMESPACE,'readwrite',s=>s.put(state),'playback');},
    claim:owner=>new Promise((resolve,reject)=>{
      if(!navigator.locks){reject(new Error('LOCK_UNAVAILABLE'));return;}
      void navigator.locks.request(`hirmos-offline-player:${owner}`,{ifAvailable:true},async lock=>{
        if(!lock){resolve(null);return;}
        await new Promise<void>(release=>resolve(release));
      }).catch(reject);
    }),
    url:file=>URL.createObjectURL(file),revoke:url=>URL.revokeObjectURL(url),
  }),
});

/** Scoped to the local screen: no HTTP, Socket.IO or remote playback commands. */
@Injectable()
export class OfflinePlaybackService {
  readonly audio=inject(AudioPlayerService);
  private readonly media=inject(MediaSessionService);
  private readonly session=inject(SessionStore);
  private readonly env=inject(OFFLINE_PLAYBACK_ENVIRONMENT);
  private readonly owner=this.session.localOwner()!;
  readonly listens=inject(OfflineListenRecorder);
  private readonly meter=new ListenMeter(report=>this.listens.record(this.owner,report));
  readonly state=signal<OfflineQueue>(emptyOfflineQueue(this.owner));
  readonly ready=signal(false);
  readonly opening=signal(false);
  readonly error=signal('');
  readonly owns=signal(false);
  readonly inventoryRevision=signal(0);
  readonly position=computed(()=>this.audio.track()?this.audio.positionSeconds():this.state().positionMs/1000);
  private release:(()=>void)|null=null;
  private claiming:Promise<boolean>|null=null;
  private generation=0;
  private intent=0;
  private destroyed=false;
  private objectUrl:string|null=null;
  private writes:Promise<void>=Promise.resolve();
  private unavailable=new Set<string>();
  private readonly controller=new AbortController();
  private readonly restore:Promise<void>;
  constructor(){
    this.restore=this.read();
    this.audio.onEnded(()=>{void this.next(true);});
    this.audio.onPlaybackFailed((_message,failure)=>{
      if(['decode','unsupported'].includes(failure.code))void this.skipUnavailable('Este navegador no pudo decodificar el archivo original. No se convirtió el audio.');
      else this.error.set('No pudimos reproducir el archivo local. Puedes reintentar; no se consultará el servidor.');
    });
    this.audio.onPlaybackStarted(()=>{this.unavailable.clear();this.checkpoint();});
    this.media.registerHandlers({play:()=>{if(!this.audio.requested())void this.toggle();},pause:()=>this.pause(),next:()=>void this.next(),previous:()=>void this.previous(),
      seekTo:s=>this.seek(s),seekBy:s=>this.seek(this.position()+s)});
    effect(()=>{
      const offline=this.session.local.offline(),owner=this.session.localOwner();
      if(!offline||owner!==this.owner)untracked(()=>this.stop());
    });
    effect(()=>{this.media.synchronize({active:this.owns(),track:this.audio.track(),playing:this.audio.playing(),
      positionSeconds:this.audio.positionSeconds(),durationSeconds:this.audio.durationSeconds()});});
    effect(()=>{const error=this.listens.error();if(error&&this.owns())untracked(()=>this.error.set(error));});
    const timer=setInterval(()=>this.checkpoint(),5000);
    const hide=()=>this.checkpoint();window.addEventListener('pagehide',hide);
    inject(DestroyRef).onDestroy(()=>{this.destroyed=true;clearInterval(timer);window.removeEventListener('pagehide',hide);this.stop();this.controller.abort();});
  }
  private valid():boolean{return !this.destroyed&&this.session.local.offline()&&this.session.localOwner()===this.owner;}
  private async read():Promise<void>{
    try{const raw=await this.env.read(this.owner),state=readOfflineQueue(raw,this.owner);
      if(raw&&!state)throw new Error('INVALID_QUEUE');
      if(!this.destroyed)this.state.set(state??emptyOfflineQueue(this.owner));
    }catch{this.error.set('No pudimos recuperar la cola local. Tus archivos no se han eliminado.');}
    finally{this.ready.set(true);}
  }
  private async acquire():Promise<boolean>{
    await this.restore;
    if(!this.valid())return false;
    if(this.release)return true;
    if(this.claiming)return this.claiming;
    const operation=(async()=>{
      try{
        const release=await this.env.claim(this.owner);
        if(!release){this.error.set('Otra pestaña tiene la reproducción offline. Ciérrala o vuelve allí para continuar.');return false;}
        if(!this.valid()){release();return false;}
        this.release=release;this.owns.set(true);await this.read();
        return this.valid();
      }catch{this.error.set('No pudimos obtener el control local de reproducción.');return false;}
    })();
    this.claiming=operation;
    try{return await operation;}finally{this.claiming=null;}
  }
  private save():void{
    if(!this.release)return;
    const state=structuredClone(this.state());
    this.writes=this.writes.then(()=>this.env.save(state)).catch(()=>{
      if(!this.destroyed)this.error.set('La música puede continuar, pero no pudimos guardar la cola o la posición local.');
    });
  }
  checkpoint():void{
    if(!this.release)return;
    this.sampleListen();
    if(this.audio.track())this.state.update(s=>({...s,positionMs:Math.min(86400000,Math.max(0,Math.round(this.audio.positionSeconds()*1000)))}));
    this.save();
  }
  async play(tracks:LocalTrack[],reference:string,shuffle?:boolean):Promise<void>{
    const intent=++this.intent;
    if(!await this.acquire()||intent!==this.intent)return;
    const queue=[...new Set(tracks.map(t=>t.reference))];
    if(queue.length>5000||!queue.includes(reference)){this.error.set('La cola local admite hasta 5.000 canciones.');return;}
    const shuffled=shuffle??this.state().shuffled;
    const candidate={...emptyOfflineQueue(this.owner),revision:this.state().revision+1,repeat:this.state().repeat,queue,
      order:shuffled?shuffledReferences(queue,reference):queue,current:reference,shuffled};
    if(!readOfflineQueue(candidate,this.owner)){this.error.set('La selección local no es válida.');return;}
    if(shuffle===undefined&&this.state().current===reference){await this.toggle();return;}
    this.error.set('');this.unavailable.clear();this.state.set(candidate);this.save();await this.open(reference,0);
  }
  async toggle():Promise<void>{
    if(this.audio.requested()){this.pause();return;}
    const intent=++this.intent;
    if(!await this.acquire()||intent!==this.intent)return;
    this.error.set('');this.unavailable.clear();
    const state=this.state(),reference=state.current??state.order[state.pastCount]??state.order[0];
    if(!reference)return;
    if(this.audio.track()?.id===reference&&this.objectUrl){
      if(!this.state().listenExecution){
        const execution={id:crypto.randomUUID(),reference,startedAt:new Date(Date.now()).toISOString()};
        this.state.update(s=>({...s,listenExecution:execution}));this.save();
        this.meter.start(execution,this.audio.positionSeconds()*1000,performance.now(),Date.now());
      }
      await this.audio.resume();return;
    }
    await this.open(reference,this.state().positionMs,true);
  }
  pause():void{this.intent++;this.generation++;this.opening.set(false);this.audio.pause();this.checkpoint();}
  async select(reference:string,revision:number):Promise<void>{
    const intent=++this.intent;
    if(!await this.acquire()||intent!==this.intent)return;
    if(this.state().revision!==revision||!this.state().queue.includes(reference)){this.error.set('La cola cambió. Revisa la selección e inténtalo de nuevo.');return;}
    if(reference===this.state().current){await this.toggle();return;}
    this.error.set('');this.unavailable.clear();await this.open(reference,0);
  }
  async edit(edit:OfflineQueueEdit,revision?:number):Promise<boolean>{
    if(!await this.acquire())return false;
    const before=this.state();
    if(revision!==undefined&&before.revision!==revision){this.error.set('La cola cambió. Revisa la selección e inténtalo de nuevo.');return false;}
    try{
      const after=editOfflineQueue(before,edit);if(after===before)return true;
      const changedCurrent=after.current!==before.current,resume=this.audio.requested()||this.opening();
      if(changedCurrent){this.intent++;this.generation++;this.clearSource();this.opening.set(false);this.unavailable.clear();}
      else if(this.audio.track())after.positionMs=Math.min(86400000,Math.max(0,Math.round(this.position()*1000)));
      this.state.set(after);this.save();this.error.set('');
      if(changedCurrent&&after.current&&resume)await this.open(after.current,0);
      return true;
    }catch(error){this.error.set(error instanceof Error&&error.message==='QUEUE_LIMIT'?'La cola local admite hasta 5.000 canciones.':'La selección ya no es válida. Revisa la cola.');return false;}
  }
  seek(seconds:number):void{
    if(!this.owns()||!Number.isFinite(seconds)||!this.audio.track())return;
    this.sampleListen();this.audio.seek(Math.min(this.audio.durationSeconds()||86400,Math.max(0,seconds)));
    this.meter.rebase(this.audio.positionSeconds()*1000,performance.now(),Date.now());this.checkpoint();
  }
  async next(ended=false):Promise<void>{
    const intent=this.intent,generation=this.generation;
    if(!await this.acquire()||intent!==this.intent||(ended&&generation!==this.generation))return;
    const next=nextOfflineReference(this.state(),1,ended);
    if(!next){this.pause();this.state.update(s=>({...s,positionMs:0,listenExecution:undefined}));this.audio.seek(0);this.meter.clear();this.save();return;}
    if(!ended){this.error.set('');this.unavailable.clear();}
    await this.open(next,0);
  }
  async previous():Promise<void>{
    const intent=this.intent;
    if(!await this.acquire()||intent!==this.intent)return;
    if(this.position()>3){this.seek(0);return;}
    const previous=nextOfflineReference(this.state(),-1);
    if(previous)await this.open(previous,0);else this.seek(0);
  }
  async repeat():Promise<void>{
    if(!await this.acquire())return;
    this.state.update(s=>({...s,revision:s.revision+1,repeat:s.repeat==='off'?'all':s.repeat==='all'?'one':'off'}));this.save();
  }
  async shuffle():Promise<void>{
    if(!await this.acquire())return;
    this.state.update(s=>({...s,revision:s.revision+1,pastCount:0,shuffled:!s.shuffled,order:s.shuffled?[...s.queue]:shuffledReferences(s.queue,s.current)}));this.save();
  }
  private async open(reference:string,positionMs:number,resuming=false):Promise<void>{
    const generation=++this.generation;
    const intent=this.intent;
    this.clearSource();this.opening.set(true);this.state.update(s=>({...s,current:reference,positionMs,pastCount:s.order.indexOf(reference),revision:s.revision+1,
      listenExecution:resuming&&s.listenExecution?.reference===reference?s.listenExecution:undefined}));this.save();
    try{
      const {record,file}=await this.env.files(this.owner).openAudio(reference,this.controller.signal);
      if(!this.valid()||generation!==this.generation||intent!==this.intent)return;
      this.objectUrl=this.env.url(file);
      const t=record.track;
      const track:Track={id:t.reference,title:t.title,artist:t.artist,album:t.album,durationMs:t.durationMs??0,
        artistId:t.artistId??null,albumId:t.albumId??null,coverUrl:null,year:null,genres:[],favorite:false};
      this.audio.load(track,this.objectUrl);this.audio.seek(positionMs/1000);
      const execution=this.state().listenExecution??{id:crypto.randomUUID(),reference,startedAt:new Date(Date.now()).toISOString()};
      this.state.update(s=>({...s,listenExecution:execution}));this.save();
      this.meter.start(execution,positionMs,performance.now(),Date.now());await this.audio.resume();
    }catch(error){
      if(!this.valid()||generation!==this.generation||intent!==this.intent)return;
      const code=error instanceof Error?error.message:'';
      if(/^LOCAL_AUDIO_(MISSING|CORRUPT|DELETED|DELETING|INTERRUPTED|WRITING)$/.test(code)){
        this.inventoryRevision.update(n=>n+1);
        await this.skipUnavailable('La descarga falta o está incompleta. Puedes repararla al volver a online.');
      }
      else this.error.set('No pudimos abrir el archivo local. Conservamos la cola; no se intentó descargar ni renovar sesión.');
    }finally{if(generation===this.generation)this.opening.set(false);}
  }
  private async skipUnavailable(message:string):Promise<void>{
    if(!this.valid()||!this.owns())return;
    const current=this.state().current;if(current)this.unavailable.add(current);
    this.error.set(message);
    if(this.unavailable.size>=3){this.pause();this.error.set(message+' Detuvimos el avance tras tres archivos fallidos.');return;}
    let candidate=nextOfflineReference(this.state(),1,false);
    if(candidate&&this.unavailable.has(candidate))candidate=null;
    if(candidate)await this.open(candidate,0);else this.pause();
  }
  private sampleListen():void{if(this.audio.track())this.meter.sample(this.audio.positionSeconds()*1000,performance.now(),Date.now());}
  private clearSource():void{this.sampleListen();this.meter.clear();this.audio.clear();if(this.objectUrl)this.env.revoke(this.objectUrl);this.objectUrl=null;}
  stop():void{
    this.checkpoint();this.intent++;this.generation++;this.clearSource();this.opening.set(false);this.media.clear();this.owns.set(false);
    const release=this.release;this.release=null;
    if(release)void this.writes.finally(release);
  }
}
