import type {OfflineListen,OfflineListenAck} from '@hirmos/contracts';

export interface ListenRow {owner:string;id:string;report:OfflineListen;retryAt:number;blocked?:string}
export interface ListenOutbox {
  put(owner:string,report:OfflineListen):Promise<void>;
  batch(owner:string,now:number):Promise<ListenRow[]>;
  acknowledge(owner:string,ids:string[],ack:OfflineListenAck,now:number):Promise<void>;
  defer(owner:string,ids:string[],until:number,blocked?:string):Promise<void>;
  cooldown(owner:string,until:number):Promise<void>;
  summary(owner:string):Promise<{pending:number;blocked:number}>;
}

/** Separate DB: upgrading reporting never blocks or migrates audio/queue storage. */
export class BrowserListenOutbox implements ListenOutbox {
  constructor(private readonly name:string){}
  private async transaction<T>(write:boolean,run:(store:IDBObjectStore,done:(value:T)=>void)=>void,table='reports'):Promise<T>{
    return new Promise((resolve,reject)=>{
      const request=indexedDB.open(this.name,1);let expired=false,active:IDBTransaction|undefined;
      const timer=setTimeout(()=>{expired=true;active?.abort();reject(new Error('LISTEN_STORAGE_TIMEOUT'));},10000);
      request.onupgradeneeded=()=>{
        const store=request.result.createObjectStore('reports',{keyPath:['owner','id']});
        store.createIndex('owner','owner');
        request.result.createObjectStore('cooldowns',{keyPath:'owner'});
      };
      request.onerror=()=>{clearTimeout(timer);reject(request.error);};
      request.onblocked=()=>{expired=true;clearTimeout(timer);reject(new Error('LISTEN_STORAGE_BLOCKED'));};
      request.onsuccess=()=>{
        const db=request.result;if(expired){db.close();return;}
        db.onversionchange=()=>db.close();
        const tx=db.transaction(table,write?'readwrite':'readonly');active=tx;let value:T;
        tx.oncomplete=()=>{clearTimeout(timer);db.close();resolve(value);};
        tx.onabort=tx.onerror=()=>{clearTimeout(timer);db.close();reject(tx.error??new Error('LISTEN_STORAGE_FAILED'));};
        try{run(tx.objectStore(table),v=>value=v);}catch(error){tx.abort();clearTimeout(timer);db.close();reject(error);}
      };
    });
  }
  put(owner:string,report:OfflineListen):Promise<void>{
    return this.transaction(true,(s,done)=>{
      const get=s.get([owner,report.id]);get.onsuccess=()=>{
        // Retrying an uncertain local commit never replaces a server deferral.
        if(!get.result)s.add({owner,id:report.id,report,retryAt:0} satisfies ListenRow);
        done(undefined);
      };
    });
  }
  async batch(owner:string,now:number):Promise<ListenRow[]>{
    const gate=await this.transaction<number>(false,(s,done)=>{const req=s.get(owner);req.onsuccess=()=>done(req.result?.until??0);},'cooldowns');
    if(gate>now)return [];
    return this.transaction(false,(s,done)=>{
      const rows:ListenRow[]=[];const cursor=s.index('owner').openCursor(IDBKeyRange.only(owner));
      cursor.onsuccess=()=>{const c=cursor.result;if(!c||rows.length>=50){done(rows);return;}
        const row=c.value as ListenRow;if(!row.blocked&&row.retryAt<=now)rows.push(row);c.continue();};
    });
  }
  acknowledge(owner:string,ids:string[],ack:OfflineListenAck,now:number):Promise<void>{
    const sent=new Set(ids);
    return this.transaction(true,(s,done)=>{
      for(const id of ack.accepted)if(sent.has(id))s.delete([owner,id]);
      for(const failure of ack.rejected)if(sent.has(failure.id)){
        const req=s.get([owner,failure.id]);req.onsuccess=()=>{if(req.result)s.put({...req.result,
          retryAt:now+3600000,blocked:failure.code==='UNKNOWN_TRACK'?undefined:failure.code});};
      }
      done(undefined);
    });
  }
  defer(owner:string,ids:string[],until:number,blocked?:string):Promise<void>{
    return this.transaction(true,(s,done)=>{
      for(const id of ids){const req=s.get([owner,id]);req.onsuccess=()=>{if(req.result)s.put({...req.result,retryAt:until,blocked});};}
      done(undefined);
    });
  }
  cooldown(owner:string,until:number):Promise<void>{
    return this.transaction(true,(s,done)=>{s.put({owner,until});done(undefined);},'cooldowns');
  }
  summary(owner:string):Promise<{pending:number;blocked:number}>{
    return this.transaction(false,(s,done)=>{
      let pending=0,blocked=0;const req=s.index('owner').openCursor(IDBKeyRange.only(owner));
      req.onsuccess=()=>{const c=req.result;if(!c){done({pending,blocked});return;}
        if(c.value.blocked)blocked++;else pending++;c.continue();};
    });
  }
}
