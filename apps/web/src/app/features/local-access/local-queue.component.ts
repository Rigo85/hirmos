import { afterNextRender, Component, computed, DestroyRef, ElementRef, inject, output, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AppIconComponent } from '../../shared/app-icon.component';
import { DownloadsService } from '../../offline/downloads.service';
import { OfflinePlaybackService } from '../../offline/offline-playback.service';
import { offlinePastCount, offlineUpcoming, type OfflineQueueEdit } from '../../offline/offline-queue';

@Component({selector:'app-local-queue',imports:[FormsModule,AppIconComponent],template:`
  <aside #panel class="queue-panel queue-panel--open" aria-label="Cola offline">
    <div class="queue-panel__head"><div><p class="eyebrow">ESTE DISPOSITIVO · OFFLINE</p><h2>Cola de reproducción</h2></div>
      <button #closeButton class="icon-button" (click)="closed.emit()" aria-label="Cerrar cola"><app-icon name="close" /></button></div>
    <p class="muted">{{player.state().queue.length}} canciones · Sin duplicados. Quitar de aquí no borra descargas.</p>
    <div class="scroll">
      <div class="tools"><button (click)="confirmClear()" [disabled]="!upcoming().length||busy()">Vaciar siguientes</button>
        <button (click)="player.shuffle()" [attr.aria-pressed]="player.state().shuffled" [disabled]="!player.state().queue.length||busy()">Aleatorio {{player.state().shuffled?'activado':'desactivado'}}</button></div>
      @if(player.state().queue.length&&player.state().repeat==='all'){<p class="muted">Al terminar volverá al inicio, incluidos los anteriores.</p>}
      @if(player.error()){<p role="status">{{player.error()}}</p>}
      @if(confirm();as pending){<section class="confirmation" aria-label="Confirmar cambio de cola"><p>{{pending.message}}</p><div class="tools"><button (click)="confirm.set(null)" [disabled]="busy()">Cancelar</button><button (click)="apply(pending.edit,pending.revision)" [disabled]="busy()">Confirmar</button></div></section>}
      @if(selection().length){<div class="tools"><span>{{selection().length}} {{selection().length===1?'seleccionada':'seleccionadas'}}</span>
        <button (click)="moveNext()" [disabled]="busy()">Mover a continuación</button>
        <label>Mover antes de<select [(ngModel)]="destination"><option value="">Final de la cola</option>@for(ref of futurePage();track ref){@if(!selected().has(ref)){<option [value]="ref">{{title(ref)}}</option>}}</select></label>
        <button (click)="move()" [disabled]="busy()">Mover</button><button (click)="apply({action:'remove',references:selection()})" [disabled]="busy()">Quitar seleccionadas</button><button (click)="selected.set(empty())">Limpiar selección</button></div>}
      @if(previous().length){<button (click)="showPrevious.set(!showPrevious())">{{showPrevious()?'Ocultar':'Mostrar'}} anteriores ({{previous().length}})</button>}
      @if(showPrevious()&&previous().length>50){<nav class="tools" aria-label="Páginas de anteriores"><button (click)="pastPage.set(safePastPage()+1)" [disabled]="(safePastPage()+1)*50>=previous().length">Más antiguas</button><span>{{previous().length-Math.min((safePastPage()+1)*50,previous().length)+1}}–{{previous().length-safePastPage()*50}} de {{previous().length}}</span><button (click)="pastPage.set(safePastPage()-1)" [disabled]="!safePastPage()">Más recientes</button></nav>}
      <ol class="entries">@for(row of rows();track row.ref){
        @if(row.heading){<li class="section-label">{{row.heading}}</li>}
        <li [class.current]="row.ref===player.state().current">
          @if(row.future){<input type="checkbox" [checked]="selected().has(row.ref)" (change)="toggle(row.ref)" [attr.aria-label]="'Seleccionar '+title(row.ref)">}
          <button class="play" [disabled]="busy()||player.opening()" (click)="player.select(row.ref,player.state().revision)" [attr.aria-label]="(playing(row.ref)?'Pausar ':'Reproducir ')+title(row.ref)"><app-icon [name]="playing(row.ref)?'pause':'play'" /></button>
          <div class="copy"><strong>{{title(row.ref)}}</strong><small>{{metadata().get(row.ref)?.track?.artist??'Archivo no disponible'}}</small></div>
          <button class="remove" [disabled]="busy()" (click)="remove(row.ref)" [attr.aria-label]="'Quitar '+title(row.ref)+' de la cola'"><app-icon name="close" /></button>
        </li>
      }@empty{<li>{{previous().length?'No quedan siguientes. Puedes volver a una anterior o añadir descargas.':'La cola está vacía. Añade canciones desde Descargas sin iniciar audio.'}}</li>}</ol>
      @if(upcoming().length>50){<nav class="tools" aria-label="Páginas de siguientes"><button (click)="page.set(safePage()-1)" [disabled]="!safePage()">Anterior</button><span>{{safePage()*50+1}}–{{Math.min((safePage()+1)*50,upcoming().length)}} de {{upcoming().length}}</span><button (click)="page.set(safePage()+1)" [disabled]="(safePage()+1)*50>=upcoming().length">Siguiente</button></nav>}
    </div>
  </aside>
`,styles:`
  :host{display:contents}.scroll{overflow:auto;min-height:0;flex:1;overscroll-behavior:contain}.muted{font-size:12px;line-height:1.5}
  .tools{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:12px 0;font-size:12px}
  .scroll button{font:inherit;font-size:12px;color:var(--text);background:#ffffff04;border:1px solid var(--line);border-radius:7px;padding:8px;cursor:pointer}
  button:disabled{opacity:.5;cursor:default}button:focus-visible,select:focus-visible,input:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
  label{display:grid;gap:6px;max-width:100%}select{max-width:100%;background:var(--surface);color:inherit;padding:8px;border:1px solid var(--line);border-radius:7px}
  .confirmation{padding:12px;border:1px solid var(--line);border-radius:10px;margin:12px 0}.confirmation p{font-size:13px}
  .entries{list-style:none;padding:0}.entries li:not(.section-label){display:flex;align-items:center;gap:7px;min-height:62px;padding:10px 4px;border-radius:8px}
  .current{background:var(--accent-soft);box-shadow:inset 3px 0 var(--accent)}.copy{min-width:0;flex:1}.copy strong,.copy small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.copy strong{font-size:13px}.copy small{color:var(--muted);font-size:11px;margin-top:4px}
  .scroll .play,.scroll .remove{border:0;background:transparent;padding:6px;flex-shrink:0}.play app-icon,.remove app-icon{width:16px;height:16px}.section-label{color:var(--accent);font-size:11px;letter-spacing:.08em;margin:18px 0 8px}
  input[type=checkbox]{width:16px;height:16px;flex-shrink:0}
  @media(max-width:760px){.queue-panel{z-index:64;width:100%;padding-bottom:max(20px,env(safe-area-inset-bottom))}.scroll button{min-height:40px}}
`})
export class LocalQueueComponent {
  readonly closed=output<void>();
  protected readonly Math=Math;
  protected readonly player=inject(OfflinePlaybackService);
  private readonly downloads=inject(DownloadsService);
  protected readonly metadata=computed(()=>new Map(this.downloads.records().map(r=>[r.track.reference,r])));
  protected readonly upcoming=computed(()=>offlineUpcoming(this.player.state()));
  protected readonly previous=computed(()=>this.player.state().order.slice(0,offlinePastCount(this.player.state())));
  protected readonly pastPage=signal(0);protected readonly safePastPage=computed(()=>Math.min(this.pastPage(),Math.max(0,Math.ceil(this.previous().length/50)-1)));
  protected readonly previousPage=computed(()=>this.previous().slice(Math.max(0,this.previous().length-(this.safePastPage()+1)*50),this.previous().length-this.safePastPage()*50));
  protected readonly page=signal(0);protected readonly safePage=computed(()=>Math.min(this.page(),Math.max(0,Math.ceil(this.upcoming().length/50)-1)));
  protected readonly futurePage=computed(()=>this.upcoming().slice(this.safePage()*50,this.safePage()*50+50));
  protected readonly showPrevious=signal(false);protected readonly selected=signal(new Set<string>());
  protected readonly selection=computed(()=>this.upcoming().filter(r=>this.selected().has(r)));
  protected readonly busy=signal(false);protected destination='';
  protected readonly confirm=signal<{edit:OfflineQueueEdit;revision:number;message:string}|null>(null);
  private readonly closeButton=viewChild<ElementRef<HTMLButtonElement>>('closeButton');
  private readonly panel=viewChild<ElementRef<HTMLElement>>('panel');
  protected readonly rows=computed(()=>{
    const rows:{ref:string;heading:string;future:boolean}[]=[];
    if(this.showPrevious())this.previousPage().forEach((ref,n)=>rows.push({ref,heading:n?'':'Anteriores',future:false}));
    const current=this.player.state().current;if(current)rows.push({ref:current,heading:'Ahora',future:false});
    this.futurePage().forEach((ref,n)=>rows.push({ref,heading:n?'':'Siguientes',future:true}));return rows;
  });
  constructor(){const focus=document.activeElement as HTMLElement|null;
    afterNextRender(()=>this.closeButton()?.nativeElement.focus());
    inject(DestroyRef).onDestroy(()=>{if(focus?.isConnected&&(document.activeElement===document.body||this.panel()?.nativeElement.contains(document.activeElement)))focus.focus();});
  }
  protected title(ref:string):string{return this.metadata().get(ref)?.track.title??'Descarga no disponible';}
  protected playing(ref:string):boolean{return ref===this.player.state().current&&this.player.audio.requested();}
  protected empty():Set<string>{return new Set();}
  protected toggle(ref:string):void{this.selected.update(s=>{const n=new Set(s);n.has(ref)?n.delete(ref):n.add(ref);return n;});}
  protected remove(ref:string):void{if(ref===this.player.state().current)this.confirm.set({edit:{action:'remove',references:[ref]},revision:this.player.state().revision,
    message:'¿Quitar la actual? Si está reproduciendo, seguirá con la siguiente. Si no queda siguiente, se detendrá; las anteriores se conservan.'});else void this.apply({action:'remove',references:[ref]});}
  protected confirmClear():void{this.confirm.set({edit:{action:'clear-upcoming'},revision:this.player.state().revision,message:`¿Quitar las ${this.upcoming().length} siguientes? La actual, las anteriores y los archivos se conservan.`});}
  protected moveNext():void{void this.apply({action:'move',references:this.selection(),before:this.upcoming().find(r=>!this.selected().has(r))??null});}
  protected move():void{void this.apply({action:'move',references:this.selection(),before:this.destination||null});}
  protected async apply(edit:OfflineQueueEdit,revision=this.player.state().revision):Promise<void>{
    if(this.busy())return;this.busy.set(true);this.confirm.set(null);
    try{if(await this.player.edit(edit,revision)){this.selected.set(new Set());this.destination='';}}finally{this.busy.set(false);}
  }
}
