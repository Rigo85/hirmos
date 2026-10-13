import { inject, InjectionToken } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import type { LyricsResponse } from '@hirmos/contracts';
import type { Observable } from 'rxjs';
import { PlaybackSyncService } from '../../core/playback-sync.service';

export interface LyricsContext {
  local:boolean;
  load(reference:string):Observable<LyricsResponse>;
  position():number;
  seek(seconds:number):void|Promise<void>;
  adjust(reference:string,adjustmentMs:number):Observable<{adjustmentMs:number}>;
}
export const LYRICS_CONTEXT=new InjectionToken<LyricsContext>('lyrics context',{
  providedIn:'root',factory:()=>{
    const http=inject(HttpClient),playback=inject(PlaybackSyncService);
    return {local:false,
      load:reference=>http.get<LyricsResponse>(`/api/music/tracks/${encodeURIComponent(reference)}/lyrics`),
      position:()=>playback.currentPositionSeconds(),seek:seconds=>playback.seek(seconds),
      adjust:(reference,adjustmentMs)=>http.put<{adjustmentMs:number}>(`/api/music/tracks/${encodeURIComponent(reference)}/lyrics-adjustment`,{adjustmentMs}),
    };
  },
});
