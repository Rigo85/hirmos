import { Injectable, inject } from '@angular/core';
import { LocalProfileStore } from './local-profile.store';

/** Registry avoids instantiating an online socket when opening an offline profile. */
@Injectable({providedIn:'root'})
export class PlaybackModeService {
  private readonly local=inject(LocalProfileStore);
  private leaveOnline:(()=>Promise<void>)|null=null;
  private transition:Promise<void>|null=null;
  registerOnline(leave:()=>Promise<void>):void{this.leaveOnline=leave;}
  async enterLocal():Promise<void>{
    if(this.transition)return this.transition;
    if(this.local.offline())return;
    const owner=this.local.value()?.user.id;
    const operation=(async()=>{
      if(!this.leaveOnline){
        // Cold access screen can follow an unconfirmed online disconnect.
        // Do not create a socket just to learn its old epoch.
        try{const device=sessionStorage.getItem(`hirmos.player-id:${owner}`);
          if(device)sessionStorage.setItem(`hirmos.local-exit:${device}`,String(Number.MAX_SAFE_INTEGER));
        }catch{/* storage unavailable; no durable device identity available */}
      }
      await this.leaveOnline?.();
      this.local.refresh();
      if(this.local.value()?.user.id!==owner||this.local.conflict())throw new Error('ACCOUNT_CHANGED');
      this.local.setMode('offline');
    })();
    this.transition=operation;
    try{await operation;}finally{this.transition=null;}
  }
}
