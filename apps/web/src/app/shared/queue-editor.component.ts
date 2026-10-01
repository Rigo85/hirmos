import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import type { PlaybackQueueItem, PlaybackSnapshot, QueueOperation } from '@hirmos/contracts';
import { PlaybackSyncService } from '../core/playback-sync.service';
import { PlaylistsService, playlistError } from '../core/playlists.service';
import { AppIconComponent } from './app-icon.component';

@Component({selector:'app-queue-editor',imports:[FormsModule,RouterLink,AppIconComponent],template:`
  <div class="queue-tools">
    <button (click)="openSave()" [disabled]="!all().length">Guardar como playlist</button>
    <button (click)="openClear()" [disabled]="!upcoming().length">Vaciar siguientes</button>
    @if(playback.snapshot()?.queueUndo;as undo){<button (click)="run({action:'undo',undoId:undo.id})" [disabled]="busy()">Deshacer eliminación</button>}
  </div>
  @if(all().length && playback.snapshot()?.repeatMode==='all'){<p class="section-label">Al terminar, volverá al inicio de esta cola, incluidos los anteriores.</p>}
  @if(error()){<p role="alert">{{error()}}</p>}
  @if(saved();as id){<p role="status">Playlist guardada. <a [routerLink]="['/playlists',id]">Abrir</a></p>}
  @if(saving()){
    <form (ngSubmit)="save()"><label>Nombre de playlist<input name="queuePlaylistName" [(ngModel)]="name" maxlength="120" required></label>
      <label>Contenido<select name="scope" [(ngModel)]="scope"><option value="all">Toda la cola, incluidos anteriores</option><option value="remaining">Actual y siguientes</option></select></label>
      <button [disabled]="busy()||!name.trim()">Guardar</button><button type="button" (click)="saving.set(false)">Cancelar</button>
    </form>
  }
  @if(clearing()) {<div role="alert"><p>¿Quitar las {{clearCount}} siguientes? La canción actual y los anteriores se conservan. Si cambia la cola, tendrás que revisar la selección.</p><button (click)="clear()" [disabled]="busy()">Sí, vaciar siguientes</button><button (click)="clearing.set(false)">Cancelar</button></div>}
  @if(removingCurrent();as id){<div role="alert"><p>¿Quitar la actual y pasar a la siguiente? Si no queda otra, se detendrá.</p><button (click)="removeCurrent(id)" [disabled]="busy()">Quitar actual y seguir</button><button (click)="removingCurrent.set(null)">Cancelar</button></div>}
  @if(selected().size){<div class="queue-tools"><span>{{selected().size}} seleccionadas</span>
    <button (click)="moveNext()" [disabled]="busy()">Mover a continuación</button>
    <label>Mover antes de<select [(ngModel)]="destination"><option value="">Final de la cola</option>@for(i of upcoming().slice(0,limit());track i.id){@if(!selected().has(i.id)){<option [value]="i.id">{{title(i)}}</option>}}</select></label>
    <button (click)="move()" [disabled]="busy()">Mover</button><button (click)="removeSelected()" [disabled]="busy()">Quitar seleccionadas</button>
    <button (click)="selected.set(emptySelection())">Limpiar selección</button></div>}
  @if(previous().length){<button (click)="showPrevious.update(invert)">{{showPrevious()?'Ocultar':'Mostrar'}} anteriores en esta cola ({{previous().length}})</button>}
  <ol class="entries">
    @for(row of rows();track row.item.id){
      @if(row.heading){<li class="section-label">{{row.heading}}</li>}
      <li [class.current]="row.item.id===playback.snapshot()?.currentQueueItemId" [draggable]="row.future&&!busy()"
        (dragstart)="dragging=row.item.id" (dragover)="$event.preventDefault()" (drop)="drop($event,row.item)">
        @if(row.future){<input type="checkbox" [checked]="selected().has(row.item.id)" (change)="toggle(row.item.id)" [attr.aria-label]="'Seleccionar '+title(row.item)">}
        <button class="play" (click)="play(row.item)" [attr.aria-label]="(isPlaying(row.item)?'Pausar ':'Reproducir ')+title(row.item)"><app-icon [name]="isPlaying(row.item)?'pause':'play'" /></button>
        <div class="copy"><strong>{{title(row.item)}}</strong>@if(playback.trackFor(row.item.trackRef);as track){<small>@if(track.artistId){<a [routerLink]="['/artists',track.artistId]">{{track.artist}}</a>}@else{<span>{{track.artist}}</span>} · @if(track.albumId){<a [routerLink]="['/albums',track.albumId]">{{track.album}}</a>}@else{<span>{{track.album}}</span>}</small>}</div>
        <button class="remove" (click)="requestRemove(row.item.id)" [attr.aria-label]="'Quitar '+title(row.item)+' de la cola'"><app-icon name="close" /></button>
      </li>
    }@empty{<li>{{previous().length?'No quedan canciones siguientes. Puedes consultar las anteriores.':'La cola está vacía. Añade música para prepararla sin iniciar audio.'}}</li>}
  </ol>
  @if(upcoming().length>limit()){<button (click)="limit.update(more)">Cargar 100 más · {{limit()}} de {{upcoming().length}} siguientes</button>}
  @if(showPrevious()&&previous().length>pastLimit()){<button (click)="pastLimit.update(more)">Mostrar 100 anteriores más</button>}
`,styles:[`
  :host{display:block;min-height:0;overflow:auto;overscroll-behavior:contain;padding:0 2px 12px;scrollbar-width:thin}
  button{color:inherit;background:#ffffff04;border:1px solid var(--line);border-radius:7px;padding:8px;cursor:pointer;font:inherit;font-size:12px}
  button:hover{border-color:var(--accent)}button:disabled{opacity:.5;cursor:default}.queue-tools{display:flex;gap:7px;flex-wrap:wrap;margin:12px 0;font-size:12px}
  form,[role=alert]{padding:12px;border:1px solid var(--line);border-radius:10px;margin:12px 0}label{display:grid;gap:6px;margin:8px 0}
  input:not([type=checkbox]),select{background:var(--surface);color:inherit;border:1px solid var(--line);padding:8px;min-width:0;max-width:100%}
  .entries{list-style:none;padding:0;margin:12px 0}.entries li:not(.section-label){display:flex;align-items:center;gap:7px;padding:10px 4px;border-radius:8px;min-height:62px}
  .current{background:var(--accent-soft);box-shadow:inset 3px 0 var(--accent)}.copy{min-width:0;flex:1}.copy strong{font-size:13px;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .copy small{display:block;font-size:11px;color:var(--muted);margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.copy a{color:inherit}
  .play,.remove{border:0;background:transparent;padding:6px;flex-shrink:0}.play app-icon,.remove app-icon{width:16px;height:16px}.section-label{color:var(--accent);font-size:11px;letter-spacing:.08em;margin:18px 0 8px}
  input[type=checkbox]{width:16px;height:16px;flex-shrink:0}
`]})
export class QueueEditorComponent {
  protected readonly playback=inject(PlaybackSyncService);
  private readonly playlists=inject(PlaylistsService);
  protected readonly all=computed(()=>this.playback.snapshot()?.queue??[]);
  private readonly index=computed(()=>this.all().findIndex(i=>i.id===this.playback.snapshot()?.currentQueueItemId));
  protected readonly previous=computed(()=>this.all().slice(0,this.index()<0?this.playback.snapshot()?.queuePastCount??0:this.index()));
  protected readonly upcoming=computed(()=>this.all().slice(this.index()<0?this.playback.snapshot()?.queuePastCount??0:this.index()+1));
  protected readonly showPrevious=signal(false);protected readonly limit=signal(100);protected readonly pastLimit=signal(100);
  protected readonly selected=signal(new Set<string>());protected readonly busy=signal(false);protected readonly error=signal('');
  protected readonly clearing=signal(false);protected readonly removingCurrent=signal<string|null>(null);
  protected readonly saving=signal(false);protected readonly saved=signal('');
  protected name='';protected scope:'all'|'remaining'='remaining';protected destination='';protected dragging:string|null=null;
  private saveBasis:PlaybackSnapshot|null=null;
  private confirmationBasis:PlaybackSnapshot|null=null;
  protected clearCount=0;
  protected readonly rows=computed(()=>{
    const rows:{item:PlaybackQueueItem;heading:string;future:boolean}[]=[];
    if(this.showPrevious())this.previous().slice(-this.pastLimit()).forEach((item,n)=>rows.push({item,heading:n?'':'Anteriores en esta cola',future:false}));
    const current=this.all()[this.index()];if(current)rows.push({item:current,heading:'Ahora',future:false});
    let priority:boolean|undefined;
    this.upcoming().slice(0,this.limit()).forEach(item=>{const p=Boolean(item.priority);rows.push({item,heading:priority===p?'':p?'Tus siguientes':'Después',future:true});priority=p;});
    return rows;
  });
  constructor(){effect(()=>{
    const references=this.rows().map(r=>r.item.trackRef);
    untracked(()=>{void this.playback.ensureQueueTracks(references);});
  });effect(()=>{
    const ids=new Set(this.upcoming().map(i=>i.id));
    untracked(()=>this.selected.update(old=>new Set([...old].filter(id=>ids.has(id)))));
  });}
  protected invert=(value:boolean)=>!value;protected more=(value:number)=>value+100;
  protected emptySelection():Set<string>{return new Set();}
  protected title(item:PlaybackQueueItem):string{return this.playback.trackFor(item.trackRef)?.title??'Cargando…';}
  protected isPlaying(item:PlaybackQueueItem):boolean{return item.id===this.playback.snapshot()?.currentQueueItemId&&this.playback.snapshot()?.status==='playing';}
  protected toggle(id:string):void{this.selected.update(old=>{const next=new Set(old);next.has(id)?next.delete(id):next.add(id);return next;});}
  protected async run(operation:QueueOperation,basis?:PlaybackSnapshot|null):Promise<void>{if(this.busy())return;this.busy.set(true);try{if(await (basis===undefined?this.playback.editQueue(operation):this.playback.editQueue(operation,basis)))this.selected.set(new Set());}finally{this.busy.set(false);}}
  protected play(item:PlaybackQueueItem):void{if(item.id===this.playback.snapshot()?.currentQueueItemId)void this.playback.toggle();else void this.run({action:'select',itemId:item.id});}
  protected requestRemove(id:string):void{if(id===this.playback.snapshot()?.currentQueueItemId){this.clearing.set(false);this.confirmationBasis=this.playback.snapshot();this.removingCurrent.set(id);}else void this.run({action:'remove',itemIds:[id]});}
  protected removeSelected():void{void this.run({action:'remove',itemIds:[...this.selected()]});}
  protected async removeCurrent(id:string):Promise<void>{this.removingCurrent.set(null);await this.run({action:'remove',itemIds:[id]},this.confirmationBasis);}
  protected openClear():void{this.removingCurrent.set(null);this.confirmationBasis=this.playback.snapshot();this.clearCount=this.upcoming().length;this.clearing.set(true);}
  protected async clear():Promise<void>{this.clearing.set(false);await this.run({action:'clear-upcoming'},this.confirmationBasis);}
  protected moveNext():void{const target=this.upcoming().find(i=>!this.selected().has(i.id));void this.run({action:'move',itemIds:[...this.selected()],beforeId:target?.id??null,priority:true});}
  protected move():void{const target=this.upcoming().find(i=>i.id===this.destination);void this.run({action:'move',itemIds:[...this.selected()],beforeId:target?.id??null,priority:Boolean(target?.priority)});}
  protected drop(event:DragEvent,target:PlaybackQueueItem):void{event.preventDefault();if(this.dragging&&this.dragging!==target.id)void this.run({action:'move',itemIds:[this.dragging],beforeId:target.id,priority:Boolean(target.priority)});this.dragging=null;}
  protected openSave():void{this.saveBasis=this.playback.snapshot();this.saving.set(true);this.saved.set('');this.error.set('');}
  protected async save():Promise<void>{const s=this.saveBasis;if(!s||this.busy()||!this.name.trim())return;this.busy.set(true);this.error.set('');
    try{const result=await this.playlists.command({action:'from-queue',commandId:crypto.randomUUID(),name:this.name.trim(),description:'',scope:this.scope,expectedQueueRevision:s.queueRevision,currentQueueItemId:s.currentQueueItemId});this.saved.set(result.playlistId);this.saving.set(false);}
    catch(e){this.error.set(playlistError(e));}finally{this.busy.set(false);}
  }
}
