import { Component, computed, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { PlaylistSummary, Track } from '@hirmos/contracts';
import { DownloadsService } from '../offline/downloads.service';
import { downloadMessage } from '../offline/download-transport';
import { AppIconComponent } from './app-icon.component';

@Component({selector:'app-download-button',imports:[RouterLink,AppIconComponent],host:{'[class.mobile-tile]':'mobileTile()'},template:`
  @if(complete()&&!favorites()){
    <a class="outline-button" routerLink="/downloads" title="Gestionar descarga en este navegador"><app-icon name="downloaded" /><span>Descargado</span></a>
  }@else{
    <button class="outline-button" type="button" [disabled]="busy() || !downloads.canDownload() || (favorites() && (downloads.favoritesBusy() || downloads.activePlan()==='favorites:favorites' || downloads.queued().includes('favorites:favorites'))) || (!favorites() && !playlist() && !tracks().length)" (click)="download()">
      <app-icon name="download" /><span>{{busy()?'Preparando…':favorites()?(plan()?'Actualizar descarga':'Descargar originales'):plan()?'Completar descarga':'Descargar'}}</span>
    </button>
    @if(done() || (favorites() && plan())){<span role="status"><a routerLink="/downloads">Ver descargas</a></span>}
  }
  @if(error()){<p class="form-error" role="alert">{{error()}}</p>}
`,styles:`:host{display:inline-flex;align-items:center;gap:12px;flex-wrap:wrap}button,a.outline-button{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:44px;white-space:nowrap;text-decoration:none;margin:0}app-icon{font-size:18px}a{color:var(--accent)}p{flex-basis:100%;margin:8px 0}
@media(min-width:761px){
  :host(.mobile-tile){display:contents}
  :host(.mobile-tile)>span[role=status],:host(.mobile-tile)>p{flex-basis:100%;min-width:0;margin:0;overflow-wrap:anywhere}
}
@media(max-width:760px){
  :host(.mobile-tile){display:contents}
  :host(.mobile-tile) :is(button,a.outline-button){display:grid;grid-template-rows:20px auto;align-content:center;justify-items:center;gap:6px;min-width:0;min-height:76px;padding:10px 6px;font-size:.875rem;line-height:1.3;white-space:normal;text-align:center}
  :host(.mobile-tile) app-icon{width:20px;height:20px}
  :host(.mobile-tile)>span[role=status],:host(.mobile-tile)>p{grid-column:1/-1;min-width:0;margin:0;overflow-wrap:anywhere}
  :host(.mobile-tile)>span[role=status] a{display:inline-flex;align-items:center;min-height:48px}
  @container album-actions (max-width:18em){:host(.mobile-tile) :is(button,a.outline-button){display:flex;justify-content:center;min-height:48px;gap:8px}}
}`})
export class DownloadButtonComponent {
  protected readonly downloads=inject(DownloadsService);
  readonly favorites=input(false);
  readonly mobileTile=input(false);
  readonly tracks=input<Track[]>([]);
  readonly album=input<{id:string;name:string}|null>(null);
  readonly playlist=input<PlaylistSummary|null>(null);
  protected readonly plan=computed(()=>this.downloads.savedPlans().find(p=>
    p.id===(this.favorites()?'favorites:favorites':this.playlist()?`playlist:${this.playlist()!.id}`:this.album()?`album:${this.album()!.id}`:this.tracks().length===1?`track:${this.tracks()[0]!.id}`:'')));
  protected readonly complete=computed(()=>{
    const plan=this.plan();if(!plan||!plan.tracks.every(t=>this.downloads.ready().has(t.reference)))return false;
    return this.playlist()?plan.revision===this.playlist()!.revision:this.tracks().every(t=>plan.tracks.some(p=>p.reference===t.id));
  });
  protected readonly busy=signal(false);protected readonly done=signal(false);protected readonly error=signal('');
  protected async download():Promise<void> {
    if(this.busy())return;this.busy.set(true);this.error.set('');this.done.set(false);
    try {
      const playlist=this.playlist(),album=this.album();
      if(this.favorites())await this.downloads.enqueueFavorites();
      else if(playlist)await this.downloads.enqueuePlaylist(playlist);
      else await this.downloads.enqueue(this.tracks(),album?'album':'track',album?.id,album?.name);
      this.done.set(true);
    }catch(error){this.error.set(downloadMessage(error));}
    finally{this.busy.set(false);}
  }
}
