import { Component, DestroyRef, ElementRef, effect, inject, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { PlaylistSummary } from '@hirmos/contracts';
import { PlaylistsService, playlistError } from '../core/playlists.service';

@Component({selector:'app-playlist-picker',imports:[FormsModule],template:`
  <dialog #dialog aria-labelledby="playlist-picker-title" (cancel)="cancel($event)" (close)="close()">
    <h2 id="playlist-picker-title">Añadir a playlist</h2>
    <p>{{ service.selection()?.length }} canciones seleccionadas</p>
    @if(error()) { <p role="alert">{{error()}}</p> }
    @if(message()) { <p role="status">{{message()}}</p> }
    @if(loading()) { <p>Cargando tus playlists…</p> }
    <label>Playlist <select [(ngModel)]="target" [disabled]="busy()">
      <option value="">Crear una nueva…</option>
      @for(list of lists();track list.id) { <option [value]="list.id">{{list.name}} · {{list.count}} canciones</option> }
    </select></label>
    @if(!target) { <label>Nombre <input [(ngModel)]="name" maxlength="120" placeholder="Mi playlist" [disabled]="busy()"></label> }
    <small>Solo se añaden las canciones que faltan; las existentes conservan su posición.</small>
    <div class="actions"><button type="button" (click)="save()" [disabled]="busy() || loading() || !!message() || (!target && !name.trim())">{{busy()?'Guardando…':message()?'Añadido':'Añadir'}}</button><button type="button" (click)="close()" [disabled]="busy()">Cerrar</button></div>
  </dialog>
`,styles:[`
  dialog { width:min(440px,calc(100vw - 32px)); border:1px solid #45403a; border-radius:16px; padding:24px; background:#14171b; color:#f3f0e9; }
  dialog::backdrop { background:#000a; } h2 { margin-top:0; } label { display:grid; gap:8px; margin:16px 0; }
  input,select { width:100%; padding:10px; border:1px solid #555; border-radius:6px; background:#090c10; color:inherit; }
  .check { display:flex; align-items:center; } .check input { width:auto; } .actions { display:flex; gap:12px; margin-top:20px; }
  button { padding:10px 16px; cursor:pointer; } [role=alert] { color:#ffb2a5; }
`]})
export class PlaylistPickerComponent {
  protected readonly service=inject(PlaylistsService);
  private readonly dialog=viewChild<ElementRef<HTMLDialogElement>>('dialog');
  protected readonly lists=signal<PlaylistSummary[]>([]);
  protected readonly busy=signal(false); protected readonly loading=signal(false);
  protected readonly error=signal(''); protected readonly message=signal('');
  protected target=''; protected name='';
  private generation=0;
  constructor() { inject(DestroyRef).onDestroy(()=>{this.generation++;this.service.selection.set(null);});effect(()=>{if(this.service.selection() && this.dialog()) {this.dialog()!.nativeElement.showModal(); void this.load();}}); }
  protected close():void { if(this.busy()) return; this.generation++; this.service.selection.set(null); this.dialog()?.nativeElement.close(); }
  protected cancel(event:Event):void { if(this.busy())event.preventDefault();else this.close(); }
  private async load():Promise<void> {
    const generation=++this.generation; this.loading.set(true); this.error.set(''); this.message.set(''); this.target=''; this.name='';
    try {const {playlists}=await this.service.list(); if(generation===this.generation) this.lists.set(playlists);}
    catch(e){if(generation===this.generation)this.error.set(playlistError(e));}
    finally{if(generation===this.generation)this.loading.set(false);}
  }
  protected async save():Promise<void> {
    const tracks=this.service.selection(); if(!tracks?.length || this.busy())return;
    this.busy.set(true);this.error.set('');this.message.set('');
    try {
      let playlist=this.lists().find(p=>p.id===this.target);
      if(!playlist) {
        const created=await this.service.command({action:'create',commandId:crypto.randomUUID(),name:this.name.trim(),description:''});
        playlist={id:created.playlistId,name:this.name.trim(),description:'',revision:created.revision,count:0,durationMs:0,covers:[]};
        this.lists.update(l=>[playlist!,...l]);this.target=playlist.id;
      }
      const result=await this.service.command({action:'add',commandId:crypto.randomUUID(),playlistId:playlist.id,
        expectedRevision:playlist.revision,trackRefs:tracks.map(t=>t.id),duplicates:'skip'});
      this.message.set(result.added ? `${result.added} añadidas${result.skipped ? ` · ${result.skipped} ya estaban en la playlist o en la selección` : ''}.`
        : 'Estas canciones ya están en la playlist.');
      this.lists.update(l=>l.map(p=>p.id===playlist!.id?{...p,revision:result.revision,count:p.count+result.added}:p));
    } catch(e){this.error.set(playlistError(e));}
    finally{this.busy.set(false);}
  }
}
