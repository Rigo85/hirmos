import { Injectable, InjectionToken, inject } from '@angular/core';
import { SessionStore } from '../core/session.store';
import { browserDownloadStorage } from './browser-download-storage';
import { LocalDownloads } from './local-downloads';
import { adjustLocalLyrics, localCover, savedLyrics } from './download-extras';

export const LOCAL_EXTRAS_FILES=new InjectionToken<(owner:string)=>LocalDownloads>('local extras files',{
  providedIn:'root',factory:()=>owner=>new LocalDownloads(owner,browserDownloadStorage()),
});
/** Read-only local content except an explicit, local-only lyrics timing adjustment. */
@Injectable({providedIn:'root'})
export class LocalExtrasService {
  private readonly files=inject(LOCAL_EXTRAS_FILES);
  private readonly session=inject(SessionStore);
  async cover(owner:string,reference:string):Promise<Blob|null> {
    try {return await localCover(await this.files(owner).readExtra(reference,'cover'));}catch{return null;}
  }
  async lyrics(reference:string){
    const owner=this.session.localOwner();if(!owner)throw new Error('LOCAL_PROFILE_MISSING');
    const result=await savedLyrics(await this.files(owner).readExtra(reference,'lyrics'));
    if(owner!==this.session.localOwner())throw new Error('ACCOUNT_CHANGED');
    if(!result)throw new Error('LOCAL_LYRICS_MISSING');
    return result;
  }
  async adjust(reference:string,adjustmentMs:number){
    const owner=this.session.localOwner();if(!owner)throw new Error('LOCAL_PROFILE_MISSING');
    return adjustLocalLyrics(this.files(owner),reference,adjustmentMs,()=>{
      if(owner!==this.session.localOwner()||!this.session.local.offline())throw new Error('ACCOUNT_CHANGED');
    });
  }
}
