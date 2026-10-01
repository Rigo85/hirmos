import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import type { PlaylistCommand, PlaylistCommandResult, PlaylistPage, PlaylistSummary, Track } from '@hirmos/contracts';
import { firstValueFrom, retry, throwError, timeout, timer } from 'rxjs';

@Injectable({providedIn:'root'})
export class PlaylistsService {
  private readonly http=inject(HttpClient);
  readonly selection=signal<Track[]|null>(null);
  readonly changed=signal(0);
  open(tracks:Track[]):void { if(tracks.length) this.selection.set(tracks); }
  list():Promise<{playlists:PlaylistSummary[]}> { return firstValueFrom(this.http.get<{playlists:PlaylistSummary[]}>('/api/playlists').pipe(timeout(8000))); }
  page(id:string,offset=0,revision?:number,q=''):Promise<PlaylistPage> {
    return firstValueFrom(this.http.get<PlaylistPage>(`/api/playlists/${encodeURIComponent(id)}`,{
      params:{offset,q,...(revision===undefined?{}:{revision})},
    }).pipe(timeout(8000)));
  }
  async command(command:PlaylistCommand):Promise<PlaylistCommandResult> {
    // The same frozen command ID/payload is reused after an uncertain delivery.
    const result=await firstValueFrom(this.http.post<PlaylistCommandResult>('/api/playlists/commands',command).pipe(
      timeout(8000),retry({count:1,delay:(error)=>{
        if(error instanceof HttpErrorResponse && ![0,408,425,429,500,502,503,504].includes(error.status)) return throwError(()=>error);
        const retryAfter=error instanceof HttpErrorResponse ? error.headers.get('retry-after') : null;
        if(retryAfter) return throwError(()=>error); // Do not retry before a provider's requested delay.
        return timer(350+Math.random()*200);
      }}),
    ));
    this.changed.update(n=>n+1); return result;
  }
}
export function playlistError(error:unknown):string {
  if(error instanceof HttpErrorResponse && typeof error.error?.message==='string') return error.error.message;
  return 'No pudimos confirmar la operación. Actualiza la lista antes de volver a intentarlo.';
}
