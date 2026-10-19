import { Injectable, signal } from '@angular/core';
import type { Track } from '@hirmos/contracts';

@Injectable({providedIn:'root'})
export class QueueMenuService {
  readonly tracks=signal<Track[]|null>(null);
  readonly showFavorite=signal(false);
  readonly favoriteAction=signal<(() => Promise<void>) | null>(null);
  open(tracks:Track[],showFavorite=false,favoriteAction:(() => Promise<void>) | null=null):void {
    if(tracks.length){
      this.showFavorite.set(showFavorite && tracks.length===1);
      this.favoriteAction.set(this.showFavorite()?favoriteAction:null);
      this.tracks.set(tracks);
    }
  }
  close():void {
    this.tracks.set(null);this.showFavorite.set(false);this.favoriteAction.set(null);
  }
}
