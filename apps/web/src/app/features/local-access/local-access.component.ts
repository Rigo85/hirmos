import { Component, computed, effect, HostListener, inject, signal, untracked } from '@angular/core';
import { DOCUMENT, NgTemplateOutlet } from '@angular/common';
import { Router } from '@angular/router';
import { SessionStore } from '../../core/session.store';
import { DownloadsComponent } from '../downloads/downloads.component';
import { LocalQueueComponent } from './local-queue.component';
import type { LocalTrack } from '../../offline/local-downloads';
import { AudioPlayerService, HIRMOS_AUDIO_ELEMENT } from '../../core/audio-player.service';
import { MediaSessionService, HIRMOS_MEDIA_LOCAL_ONLY } from '../../core/media-session.service';
import { OfflinePlaybackService } from '../../offline/offline-playback.service';
import { DownloadsService } from '../../offline/downloads.service';
import { AppIconComponent } from '../../shared/app-icon.component';
import { PlayerBarComponent } from '../../shared/player-bar.component';
import { NowPlayingComponent } from '../../shared/now-playing.component';
import { RepeatControlComponent } from '../../shared/repeat-control.component';
import { LyricsPanelComponent } from '../lyrics/lyrics-panel.component';
import { LYRICS_CONTEXT, type LyricsContext } from '../lyrics/lyrics-context';
import { LocalExtrasService } from '../../offline/local-extras.service';
import { defer } from 'rxjs';
import type { Track } from '@hirmos/contracts';

function localLyricsContext():LyricsContext {
  const extras=inject(LocalExtrasService),playback=inject(OfflinePlaybackService);
  return {local:true,load:ref=>defer(()=>extras.lyrics(ref)),position:()=>playback.position(),
    seek:seconds=>playback.seek(seconds),adjust:(ref,ms)=>defer(()=>extras.adjust(ref,ms))};
}

/** A separate instance of the common audio engine; never instantiate the online coordinator. */
@Component({
  selector: 'app-local-access',
  imports: [DownloadsComponent, LocalQueueComponent, AppIconComponent, NgTemplateOutlet, PlayerBarComponent, NowPlayingComponent, RepeatControlComponent, LyricsPanelComponent],
  providers:[OfflinePlaybackService,AudioPlayerService,MediaSessionService,
    {provide:HIRMOS_AUDIO_ELEMENT,useFactory:()=>new Audio()},{provide:HIRMOS_MEDIA_LOCAL_ONLY,useValue:true},
    {provide:LYRICS_CONTEXT,useFactory:localLyricsContext}],
  template: `
    <header>
      <strong>Hirmos · Modo offline</strong
      ><span>{{ store.local.value()?.user?.displayName }}</span>
      <button class="outline-button" [disabled]="busy() || store.busy()" (click)="returnOnline()">
        Volver a online
      </button>
    </header>
    <main>
      <p class="muted">
        Solo tus descargas, con una cola independiente. Recuperar Internet no cambia este modo.
      </p>
      @if (error()) {
        <p role="status">{{ error() }}</p>
      }
      @if(playback.error()){<div class="local-notice" role="status">{{playback.error()}} <button class="outline-button" (click)="playback.error.set('')">Cerrar aviso</button></div>}
      @if(playback.audio.phase()==='awaiting_interaction'){<p role="status">Pulsa Reproducir para habilitar el audio en este navegador.</p>}
      <app-downloads [localOnly]="true" [currentLocal]="playback.state().current" [localPlaying]="playback.audio.requested()"
        (playLocal)="playback.play($event.tracks,$event.reference,$event.shuffle)" (queueLocal)="append($event)" />
    </main>
    <app-lyrics-panel [open]="lyricsOpen()" [mobileFullscreen]="mobilePlayerOpen()" [track]="lyricsTrack()" (closed)="lyricsOpen.set(false)" />
    @if(queueOpen()){<app-local-queue (closed)="queueOpen.set(false)" />}
    <app-player-bar [title]="title()" [coverUrl]="coverUrl()" [hasTrack]="!!playback.state().current"
      [playing]="playback.audio.requested()" [canPlay]="!!playback.state().queue.length && !playback.opening()"
      [canNavigate]="!!playback.state().current && !playback.opening()" [canSeek]="!!playback.audio.track() && !playback.opening()"
      [position]="playback.position()" [duration]="duration()" [seekStep]="0.1" seekLabel="Posición offline"
      [volume]="playback.audio.volume()" [muted]="playback.audio.muted()" [volumeStep]="0.01"
      [bottomNavigation]="false" label="Reproductor offline"
      (previous)="playback.previous()" (toggle)="playback.toggle()" (next)="playback.next()"
      (seek)="seek($event)" (mute)="playback.audio.toggleMuted()" (volumeChange)="changeVolume($event)"
      (expand)="openMobilePlayer()">
      <small playerMetadata class="entity-links"><span>{{artist()}}</span>@if(album()){<span aria-hidden="true">·</span><span>{{album()}}</span>}</small>
      @if(playback.state().current){<button playerFavorite class="offline-unavailable" type="button" disabled
        aria-label="Favoritos: todavía no disponibles en modo offline" title="Favoritos: todavía no disponibles en modo offline"><app-icon name="heart" /></button>}
      <ng-container playerActions><ng-container *ngTemplateOutlet="localActions; context: {$implicit: false}" /></ng-container>
    </app-player-bar>
    @if(mobilePlayerOpen() && playback.state().current){
      <app-now-playing [title]="title()" [artist]="artist()" [album]="album()" [coverUrl]="coverUrl()" [duration]="duration()"
        [position]="seekPreview() ?? playback.position()" [playing]="playback.audio.requested()"
        [canPlay]="!!playback.state().queue.length && !playback.opening()"
        [canNavigate]="!!playback.state().current && !playback.opening()" [canSeek]="!!playback.audio.track() && !playback.opening()"
        (close)="closeMobilePlayer()" (previous)="playback.previous()"
        (toggle)="playback.toggle()" (next)="playback.next()" (preview)="previewSeek($event)" (seek)="seek($event)">
        <ng-container playerStatus>Modo offline · Este dispositivo</ng-container>
        <ng-container playerNotice>@if(playback.error()){<p role="status">{{playback.error()}}</p>}</ng-container>
        <button playerFavorite class="offline-unavailable" type="button" disabled
          aria-label="Favoritos: todavía no disponibles en modo offline" title="Favoritos: todavía no disponibles en modo offline"><app-icon name="heart" /></button>
        <ng-container playerActions><ng-container *ngTemplateOutlet="localActions; context: {$implicit: true}" /></ng-container>
        <p playerClaim class="offline-capabilities">Favoritos todavía no disponibles en modo offline.</p>
      </app-now-playing>
    }
    <ng-template #localActions let-expanded>
      <app-repeat-control [mode]="playback.state().repeat" [showLabel]="expanded" [disabled]="!playback.state().queue.length" (cycle)="playback.repeat()" />
      <button class="player-action" type="button" [disabled]="!playback.state().current" [class.player-action--active]="lyricsOpen()"
        [attr.aria-label]="lyricsOpen()?'Cerrar letra':'Mostrar letra'" [attr.aria-pressed]="lyricsOpen()" (click)="toggleLyrics()"><app-icon name="lyrics" />@if(expanded){<span>Letra</span>}</button>
      <button class="player-action" type="button" [class.player-action--active]="queueOpen()" [attr.aria-pressed]="queueOpen()"
        [attr.aria-label]="queueOpen()?'Cerrar cola':'Mostrar cola'" (click)="toggleQueue()"><app-icon name="queue" />@if(expanded){<span>Cola</span>}</button>
    </ng-template>
  `,
  styles: `
    :host {
      display: block;
      min-height: 100dvh;
      background: var(--bg);
      color: var(--text);
    }
    header {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 16px;
      padding: 24px;
      border-bottom: 1px solid var(--line);
    }
    header span {
      flex: 1;
      color: var(--muted);
    }
    main {
      max-width: 1200px;
      margin: auto;
      padding: 24px 24px calc(var(--player) + 32px);
    }
    .local-notice{padding:16px;border:1px solid var(--line);border-radius:10px;line-height:1.5}.local-notice button{margin-left:12px}
    button.offline-unavailable:disabled{opacity:.4;cursor:not-allowed}
    button.offline-unavailable:disabled:hover{color:var(--muted);background:transparent}
    .offline-capabilities{color:var(--muted);font-size:12px;line-height:1.5;margin:12px 0 0}
    @media(max-width:760px){
      header{padding:16px;gap:12px}main{padding:16px 0 calc(var(--player) + 32px + env(safe-area-inset-bottom))}
    }
  `,
})
export class LocalAccessComponent {
  protected readonly playback=inject(OfflinePlaybackService);
  private readonly downloads=inject(DownloadsService);
  private readonly extras=inject(LocalExtrasService);
  protected readonly lyricsOpen=signal(false);
  protected readonly queueOpen=signal(false);
  protected toggleLyrics():void{this.queueOpen.set(false);this.lyricsOpen.set(!this.lyricsOpen());}
  protected toggleQueue():void{this.lyricsOpen.set(false);this.queueOpen.set(!this.queueOpen());}
  protected async append(tracks:LocalTrack[]):Promise<void>{
    if(await this.playback.edit({action:'append',references:tracks.map(t=>t.reference)})){
      this.lyricsOpen.set(false);this.queueOpen.set(true);
    }
  }
  protected readonly coverUrl=signal<string|null>(null);
  protected readonly store = inject(SessionStore);
  private readonly router = inject(Router);
  private readonly document = inject(DOCUMENT);
  protected readonly mobilePlayerOpen = signal(false);
  protected readonly seekPreview = signal<number|null>(null);
  private mobileHistoryEntry = false;
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly title=computed(()=>this.playback.audio.track()?.title??this.downloads.records().find(r=>r.track.reference===this.playback.state().current)?.track.title??(this.playback.state().queue.length?'Cola preparada':'Elige una descarga'));
  protected readonly artist=computed(()=>this.playback.audio.track()?.artist??this.downloads.records().find(r=>r.track.reference===this.playback.state().current)?.track.artist??'Hirmos · Offline');
  protected readonly album=computed(()=>this.playback.audio.track()?.album??this.downloads.records().find(r=>r.track.reference===this.playback.state().current)?.track.album??'');
  protected readonly duration=computed(()=>this.playback.audio.durationSeconds()||
    (this.downloads.records().find(r=>r.track.reference===this.playback.state().current)?.track.durationMs??0)/1000);
  protected readonly lyricsTrack=computed<Track|null>(()=>{
    const row=this.downloads.records().find(r=>r.track.reference===this.playback.state().current)?.track;
    return row?{id:row.reference,title:row.title,artist:row.artist,album:row.album,durationMs:row.durationMs??0,
      artistId:row.artistId??null,albumId:row.albumId??null,coverUrl:null,year:null,genres:[],favorite:false}:null;
  });
  constructor(){
    effect(cleanup=>{
      const owner=this.store.localOwner(),reference=this.playback.state().current;
      this.coverUrl.set(null);let cancelled=false,url:string|null=null;
      cleanup(()=>{cancelled=true;if(url)URL.revokeObjectURL(url);});
      if(owner&&reference)void this.extras.cover(owner,reference).then(blob=>{
        if(cancelled||!blob)return;url=URL.createObjectURL(blob);this.coverUrl.set(url);
      });
    });
    effect(()=>{if(this.playback.inventoryRevision())untracked(()=>{void this.downloads.refresh();});});
    effect(()=>{if(this.store.renewed())untracked(()=>this.error.set(''));});
    effect(()=>{if(!this.playback.state().current)untracked(()=>{this.lyricsOpen.set(false);this.closeMobilePlayer();});});
    effect((cleanup)=>{
      if(!this.mobilePlayerOpen())return;
      const previous=this.document.body.style.overflow;
      this.document.body.style.overflow='hidden';
      cleanup(()=>{this.document.body.style.overflow=previous;});
    });
  }
  protected openMobilePlayer():void{
    if(!this.playback.state().current || this.mobilePlayerOpen())return;
    this.mobilePlayerOpen.set(true);
    const view=this.document.defaultView;
    if(view){view.history.pushState({...view.history.state,hirmosLocalNowPlaying:true},'');this.mobileHistoryEntry=true;}
    queueMicrotask(()=>this.document.querySelector<HTMLElement>('.mobile-now-playing__close')?.focus());
  }
  protected closeMobilePlayer():void{
    if(!this.mobilePlayerOpen())return;
    const view=this.document.defaultView,pop=this.mobileHistoryEntry && view?.history.state?.hirmosLocalNowPlaying;
    this.finishClosingMobilePlayer();
    if(pop)view?.history.back();
  }
  @HostListener('window:popstate')
  protected finishClosingMobilePlayer():void{
    if(!this.mobilePlayerOpen())return;
    this.queueOpen.set(false);this.lyricsOpen.set(false);this.mobilePlayerOpen.set(false);this.mobileHistoryEntry=false;this.seekPreview.set(null);
    queueMicrotask(()=>this.document.querySelector<HTMLElement>('.mobile-player-open')?.focus());
  }
  @HostListener('document:keydown.escape')
  protected escape():void{if(this.queueOpen())this.queueOpen.set(false);else if(this.lyricsOpen())this.lyricsOpen.set(false);else this.closeMobilePlayer();}
  protected previewSeek(event:Event):void{
    const value=Number((event.target as HTMLInputElement).value);
    if(Number.isFinite(value))this.seekPreview.set(value);
  }
  protected seek(event:Event):void{
    const value=Number((event.target as HTMLInputElement).value);
    if(Number.isFinite(value))this.playback.seek(value);
    this.seekPreview.set(null);
  }
  protected changeVolume(event:Event):void{
    const value=Number((event.target as HTMLInputElement).value);
    if(Number.isFinite(value))this.playback.audio.setVolume(value);
  }
  protected async returnOnline(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    try {
      const session = await this.store.checkRemote(true);
      if (!session) {
        if (this.store.needsRenewal() && !this.store.local.conflict()) this.store.requestRenewal();
        this.error.set(this.store.local.conflict() ? 'La cuenta cambió en otra pestaña. Tu perfil local no cambió.'
          : this.store.needsRenewal() ? 'Renueva el acceso si quieres volver a online. Puedes permanecer aquí.'
          : this.store.remoteStatus() === 'forbidden' ? 'El servidor no permite el acceso. Renovar no cambia tus permisos.'
          : this.store.checkWaitSeconds() > 0 ? `El servidor pidió esperar. Puedes volver a comprobar en ${this.store.checkWaitSeconds()} s.`
          : 'No pudimos comprobar el acceso al servidor. Permaneces en el espacio local; no necesitas iniciar sesión por un corte de red.');
        return;
      }
      this.playback.stop();
      this.store.local.setMode('online');
      this.store.acceptAuthenticatedSession(session);
      if(!await this.router.navigate(['/']))throw new Error('NAVIGATION_CANCELLED');
    } catch {
      this.store.local.setMode('offline');
      this.error.set('No pudimos abrir el modo online. Sigues offline; puedes pulsar Reproducir para retomar tu cola.');
    } finally {
      this.busy.set(false);
    }
  }
}
