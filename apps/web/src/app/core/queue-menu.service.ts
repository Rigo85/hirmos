import { Injectable, signal } from '@angular/core';
import type { Track } from '@hirmos/contracts';

@Injectable({providedIn:'root'})
export class QueueMenuService {
  readonly tracks=signal<Track[]|null>(null);
  open(tracks:Track[]):void {if(tracks.length)this.tracks.set(tracks);}
}
