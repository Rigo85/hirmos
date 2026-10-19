import { Injectable, signal } from '@angular/core';
import type { Track } from '@hirmos/contracts';

@Injectable({providedIn:'root'})
export class QueueMenuService {
  readonly tracks=signal<Track[]|null>(null);
  readonly showFavorite=signal(false);
  open(tracks:Track[],showFavorite=false):void {
    if(tracks.length){this.showFavorite.set(showFavorite && tracks.length===1);this.tracks.set(tracks);}
  }
}
