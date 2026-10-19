import { Component, DestroyRef, ElementRef, effect, inject, signal, viewChild } from '@angular/core';
import type { QueuePlacement } from '@hirmos/contracts';
import { QueueMenuService } from '../core/queue-menu.service';
import { PlaybackSyncService } from '../core/playback-sync.service';
import { PlaylistsService } from '../core/playlists.service';
import { DownloadButtonComponent } from './download-button.component';
import { FavoritesService } from '../core/favorites.service';

@Component({selector:'app-queue-actions',imports:[DownloadButtonComponent],template:`
  <dialog #menu aria-labelledby="queue-actions-title" (cancel)="closeMenu()">
    <h2 id="queue-actions-title">Opciones de música</h2>
    @if(menuService.tracks()?.length === 1) {
      <div class="track-identity"><strong>{{ menuService.tracks()![0]!.title }}</strong><p>{{ menuService.tracks()![0]!.artist }}</p><p>{{ menuService.tracks()![0]!.album }}</p></div>
    } @else { <p>{{ menuService.tracks()?.length }} canciones seleccionadas</p> }
    @if(menuService.showFavorite() && menuService.tracks()?.length === 1) {
      @let track = menuService.tracks()![0]!;
      <button (click)="favorites.toggle(track)" [disabled]="busy() || favorites.isPending(track.id)"
        [attr.aria-pressed]="favorites.isFavorite(track)">
        {{ favorites.isFavorite(track) ? 'Quitar de favoritos' : 'Añadir a favoritos' }}
      </button>
      @if(favorites.error()){<p role="alert">{{ favorites.error() }}</p>}
    }
    <button (click)="add('queue')" [disabled]="busy()">Añadir a la cola <small>Después de tus elecciones pendientes</small></button>
    <button (click)="add('next')" [disabled]="busy()">Reproducir a continuación <small>Justo después de la canción actual</small></button>
    <button (click)="add('end')" [disabled]="busy()">Añadir al final <small>Después de todo lo que queda</small></button>
    <button (click)="savePlaylist()" [disabled]="busy()">Añadir a playlist…</button>
    @if(menuService.tracks();as tracks){<app-download-button [tracks]="tracks" />}
    <button (click)="closeMenu()" [disabled]="busy()">Cerrar</button>
  </dialog>
  <dialog #replace aria-labelledby="queue-replace-title" (cancel)="cancelReplacement()">
    <h2 id="queue-replace-title">¿Reemplazar la cola?</h2>
    <p>Hay cambios manuales en la cola actual. Reemplazarla descarta esa continuación, no tus playlists guardadas.</p>
    <button (click)="resolveReplacement('replace')">Reemplazar y reproducir</button>
    @if(playback.replacement()?.add){<button (click)="resolveReplacement('add')">Añadir a la cola actual</button>}
    <button (click)="cancelReplacement()">Cancelar</button>
  </dialog>
`,styles:[`
  dialog{width:min(440px,calc(100vw - 32px));padding:24px;border:1px solid var(--line);border-radius:16px;background:var(--surface);color:var(--text)}
  dialog::backdrop{background:#000a} h2{margin-top:0} p{color:var(--muted);line-height:1.6}
  .track-identity{overflow-wrap:anywhere}.track-identity strong{display:block;line-height:1.5}.track-identity p{margin:4px 0}
  button{display:block;width:100%;padding:13px;margin:9px 0;text-align:left;background:#ffffff05;color:inherit;border:1px solid var(--line);border-radius:9px;cursor:pointer}
  button:hover{border-color:var(--accent)} small{display:block;color:var(--muted);margin-top:5px}
`]})
export class QueueActionsComponent {
  protected readonly menuService=inject(QueueMenuService);
  protected readonly favorites=inject(FavoritesService);
  protected readonly playback=inject(PlaybackSyncService);
  private readonly playlists=inject(PlaylistsService);
  private readonly menu=viewChild<ElementRef<HTMLDialogElement>>('menu');
  private readonly replace=viewChild<ElementRef<HTMLDialogElement>>('replace');
  protected readonly busy=signal(false);
  constructor(){
    inject(DestroyRef).onDestroy(()=>{this.menuService.tracks.set(null);this.playback.replacement.set(null);});
    effect(()=>{const dialog=this.menu()?.nativeElement;if(this.menuService.tracks()){if(dialog&&!dialog.open)dialog.showModal();}else if(dialog?.open)dialog.close();});
    effect(()=>{const dialog=this.replace()?.nativeElement;if(this.playback.replacement()){if(dialog&&!dialog.open)dialog.showModal();}else if(dialog?.open)dialog.close();});
  }
  protected closeMenu():void {this.menuService.tracks.set(null);}
  protected async add(placement:QueuePlacement):Promise<void>{
    const tracks=this.menuService.tracks();if(!tracks||this.busy())return;
    this.busy.set(true);try{await this.playback.addTracks(tracks,placement);this.closeMenu();}finally{this.busy.set(false);}
  }
  protected savePlaylist():void{const tracks=this.menuService.tracks();this.closeMenu();if(tracks)this.playlists.open(tracks);}
  protected cancelReplacement():void{this.playback.replacement.set(null);}
  protected async resolveReplacement(action:'replace'|'add'):Promise<void>{
    const pending=this.playback.replacement();this.cancelReplacement();await pending?.[action]?.();
  }
}
