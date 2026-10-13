import {DestroyRef,Injectable,InjectionToken,effect,inject,signal,untracked} from '@angular/core';
import {HttpClient,HttpErrorResponse} from '@angular/common/http';
import {firstValueFrom,fromEvent,takeUntil,timeout} from 'rxjs';
import type {OfflineListen,OfflineListenAck} from '@hirmos/contracts';
import {SessionStore} from '../core/session.store';
import {BrowserListenOutbox,type ListenOutbox} from './listen-outbox';
import {DOWNLOAD_NAMESPACE} from './download-plans';

export const LISTEN_OUTBOX=new InjectionToken<ListenOutbox>('offline listen outbox',{
  providedIn:'root',factory:()=>new BrowserListenOutbox(`${DOWNLOAD_NAMESPACE}-listens-v1`),
});

/** Recording has no auth/network dependency. Only the sender observes online access. */
@Injectable({providedIn:'root'})
export class OfflineListenRecorder {
  private readonly outbox=inject(LISTEN_OUTBOX);
  readonly error=signal('');
  private readonly pending=new Map<string,{owner:string;report:OfflineListen}>();
  private writing=false;
  constructor(){
    const timer=setInterval(()=>void this.flush(),15000);
    inject(DestroyRef).onDestroy(()=>clearInterval(timer));
  }
  record(owner:string,report:OfflineListen):void{
    if(this.pending.size>=720){this.error.set('El almacenamiento no responde. No podemos conservar nuevas escuchas, pero el audio puede continuar.');return;}
    this.pending.set(`${owner}:${report.id}`,{owner,report});void this.flush();
  }
  async flush():Promise<void>{
    if(this.writing)return;this.writing=true;
    try{
      for(const [key,item] of this.pending){await this.outbox.put(item.owner,item.report);this.pending.delete(key);}
      this.error.set('');
    }catch{this.error.set('No pudimos guardar las últimas escuchas. Reintentaremos sin interrumpir el audio.');}
    finally{this.writing=false;}
  }
}

export interface ListenTransport {send(owner:string,reports:OfflineListen[],signal:AbortSignal):Promise<OfflineListenAck>}
// Keep the root bundle lean: only this narrow ACK shape is needed here, not
// the runtime schema library used by the API.
function validAck(value:unknown,ids:string[]):value is OfflineListenAck {
  if(!value||typeof value!=='object')return false;
  const ack=value as OfflineListenAck;
  if(!Array.isArray(ack.accepted)||!Array.isArray(ack.rejected)
    ||ack.accepted.some(id=>typeof id!=='string')
    ||ack.rejected.some(r=>!r||typeof r.id!=='string'||!['INVALID_REFERENCE','UNKNOWN_TRACK','INVALID_TIME','ID_CONFLICT'].includes(r.code)))return false;
  const all=[...ack.accepted,...ack.rejected.map(r=>r.id)];
  return all.length===ids.length&&new Set(all).size===ids.length&&all.every(id=>ids.includes(id));
}
export const LISTEN_TRANSPORT=new InjectionToken<ListenTransport>('offline listen transport',{
  providedIn:'root',factory:()=>{
    const http=inject(HttpClient);
    return {send:(owner,reports,signal)=>firstValueFrom(http.post<OfflineListenAck>('/api/activity/offline',{reports},
      {headers:{'x-hirmos-account-id':owner}}).pipe(timeout(10000),takeUntil(fromEvent(signal,'abort'))))};
  },
});

@Injectable({providedIn:'root'})
export class OfflineListenSender {
  private readonly session=inject(SessionStore);
  private readonly outbox=inject(LISTEN_OUTBOX);
  private readonly transport=inject(LISTEN_TRANSPORT);
  readonly error=signal('');
  private controller:AbortController|null=null;
  private busy=false;
  private readonly attempts=new Map<string,{failures:number;retryAt:number}>();
  constructor(){
    effect(()=>{
      const online=this.session.canUseRemote(),owner=this.session.localOwner();
      untracked(()=>{this.controller?.abort();this.controller=null;if(online&&owner)void this.flush();});
    });
    const timer=setInterval(()=>void this.flush(),15000);
    inject(DestroyRef).onDestroy(()=>{clearInterval(timer);this.controller?.abort();});
  }
  async flush():Promise<void>{
    if(this.busy||!this.session.canUseRemote())return;
    const generation=this.session.requestGeneration(),owner=this.session.localOwner();if(!owner)return;
    const attempt=this.attempts.get(owner)??{failures:0,retryAt:0};this.attempts.set(owner,attempt);
    if(Date.now()<attempt.retryAt)return;
    const controller=new AbortController();this.controller=controller;this.busy=true;
    const valid=()=>!controller.signal.aborted&&this.session.canUseRemote()&&this.session.localOwner()===owner
      &&this.session.requestGeneration()===generation;
    try{
      if(!navigator.locks)return;
      await navigator.locks.request(`hirmos-offline-report:${owner}`,{ifAvailable:true},async lock=>{
        if(!lock||!valid())return;
        // Bounded pass, yielding to UI and other tabs between batches.
        for(let batch=0;batch<10&&valid();batch++){
          const rows=await this.outbox.batch(owner,Date.now());if(!valid()||!rows.length)return;
          const ids=rows.map(r=>r.id);
          try{
            const ack:unknown=await this.transport.send(owner,rows.map(r=>r.report),controller.signal);
            if(!valid())return; // Keep uncertain ACKs; replay is idempotent.
            if(!validAck(ack,ids))throw new Error('INVALID_ACK');
            await this.outbox.acknowledge(owner,ids,ack,Date.now());
            attempt.failures=0;this.error.set(ack.rejected.length?'Algunas escuchas siguen pendientes de revisión o de encontrar la pista en el catálogo.':'');
          }catch(error){
            if(!valid())return;
            const status=error instanceof HttpErrorResponse?error.status:0;
            const retryable=[0,408,425,429].includes(status)||status>=500;
            const raw=error instanceof HttpErrorResponse?error.headers.get('retry-after'):null;
            const retryAfter=raw===null?0:/^\d+$/.test(raw)?Date.now()+Number(raw)*1000:Date.parse(raw)||0;
            attempt.retryAt=Math.max(retryAfter,Date.now()+Math.min(900000,15000*2**Math.min(6,attempt.failures++))+Math.random()*5000);
            if(retryable)await this.outbox.cooldown(owner,attempt.retryAt);
            await this.outbox.defer(owner,ids,attempt.retryAt,retryable?undefined:`HTTP_${status}`);
            this.error.set('Las escuchas siguen guardadas. No se confirmó su envío al servidor.');return;
          }
        }
      });
    }catch{attempt.retryAt=Date.now()+30000;this.error.set('No pudimos consultar el reporte local. Se conserva para reintentar.');}
    finally{if(this.controller===controller)this.controller=null;this.busy=false;}
  }
}
