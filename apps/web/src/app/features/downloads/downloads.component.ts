import { Component, ElementRef, computed, inject, input, output, signal, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';
import { DownloadsService, bytesLabel } from '../../offline/downloads.service';
import { ApplicationUpdateService } from '../../offline/application-update.service';
import { ShellReadinessComponent } from '../../offline/shell-readiness.component';
import { ListenReportStatusComponent } from '../../offline/listen-report-status.component';
import type { LocalDownload, LocalTrack } from '../../offline/local-downloads';
import type { DownloadPlan } from '../../offline/download-plans';
import { localLibrary, normalizeSearch, searchTracks, type DownloadGroup } from '../../offline/download-library';
import { downloadMessage } from '../../offline/download-transport';
import { AppIconComponent } from '../../shared/app-icon.component';
import { LazyCoverDirective } from '../../shared/lazy-cover.directive';
import { LocalCoverComponent } from '../../shared/local-cover.component';

@Component({selector:'app-downloads',imports:[RouterLink,AppIconComponent,LazyCoverDirective,LocalCoverComponent,ShellReadinessComponent,ListenReportStatusComponent],
  templateUrl:'./downloads.component.html',styleUrl:'./downloads.component.scss'})
export class DownloadsComponent {
  protected coverReference(group:DownloadGroup):string|null {
    return group.kind==='artist'?null:group.tracks.find(t=>this.downloads.ready().has(t.reference))?.reference??null;
  }
  readonly localOnly=input(false);
  readonly currentLocal=input<string|null>(null);
  readonly localPlaying=input(false);
  readonly playLocal=output<{tracks:LocalTrack[];reference:string;shuffle?:boolean}>();
  readonly queueLocal=output<LocalTrack[]>();
  protected appendRows(selected=false):void{this.queueLocal.emit((selected?this.selectedRows():this.rows()).map(row=>row.track));}
  protected playRow(reference?:string,shuffle?:boolean):void{
    const tracks=this.rows().map(row=>row.track),first=reference??tracks[0]?.reference;
    if(first)this.playLocal.emit({tracks,reference:first,shuffle});
  }
  protected readonly downloads=inject(DownloadsService);
  protected readonly applicationUpdate=inject(ApplicationUpdateService);
  protected readonly state=this.downloads.libraryState;
  protected readonly library=computed(()=>localLibrary(this.downloads.records(),this.downloads.plans()));
  protected tabCount(view:string):number|null {
    if(!this.downloads.usable())return null;
    if(view==='tracks')return this.downloads.ready().size;
    const library=this.library();
    return view==='albums'?library.albums.length:view==='artists'?library.artists.length:library.playlists.length;
  }
  protected readonly detail=computed(()=>[...this.library().albums,...this.library().artists,...this.library().playlists]
    .find(g=>`${g.kind}:${g.id}`===this.state().detail)??null);
  protected readonly groups=computed(()=>{
    const s=this.state(),q=normalizeSearch(s.query);
    const artist=this.detail()?.kind==='artist'?this.detail():null;
    const refs=artist?new Set(artist.tracks.map(t=>t.reference)):null;
    const groups=artist?this.library().albums.filter(g=>g.tracks.some(t=>refs!.has(t.reference))):s.view==='artists'?this.library().artists:s.view==='playlists'?this.library().playlists:this.library().albums;
    return groups.filter(g=>normalizeSearch(`${g.title} ${g.subtitle} ${g.tracks.map(t=>`${t.title} ${t.artist} ${t.album}`).join(' ')}`).includes(q))
      .sort((a,b)=>s.sort==='recent'?b.savedAt.localeCompare(a.savedAt)||a.title.localeCompare(b.title):a.title.localeCompare(b.title)||a.id.localeCompare(b.id));
  });
  protected readonly rows=computed(()=>{
    const detail=this.detail(),refs=detail?new Set(detail.tracks.map(t=>t.reference)):null;
    const records=this.downloads.records().filter(r=>r.state==='ready'&&(!refs||refs.has(r.track.reference)));
    const indexed=new Map(records.map(r=>[r.track.reference,r]));
    const ordered=detail?detail.tracks.flatMap(t=>indexed.has(t.reference)?[indexed.get(t.reference)!]:[]):records;
    return searchTracks(ordered,this.state().query,this.state().sort);
  });
  protected readonly artistTracks=signal(false);
  protected readonly trackView=computed(()=>this.state().view==='tracks'||(this.detail()?.kind==='artist'?this.artistTracks():!!this.detail()));
  protected readonly total=computed(()=>this.trackView()?this.rows().length:this.groups().length);
  protected readonly page=computed(()=>Math.min(this.state().page,Math.max(0,Math.ceil(this.total()/50)-1)));
  protected readonly pageRows=computed(()=>this.rows().slice(this.page()*50,this.page()*50+50));
  protected readonly pageGroups=computed(()=>this.groups().slice(this.page()*50,this.page()*50+50));
  protected readonly selected=signal<Set<string>>(new Set());
  protected readonly selectedRows=computed(()=>this.rows().filter(r=>this.selected().has(r.track.reference)));
  protected readonly pending=computed(()=>this.downloads.plans().filter(p=>p.removal==='removing'||(!p.removal&&(this.downloads.completed(p)<p.tracks.length||p.lastIssue))));
  protected readonly transferOpen=signal(false);protected readonly storageOpen=signal(false);
  protected readonly target=signal<{rows:LocalDownload[];plan:DownloadPlan|null}|null>(null);
  protected readonly deleting=signal(false);protected readonly actionError=signal('');
  protected readonly affected=computed(()=>{
    const refs=new Set(this.target()?.rows.map(r=>r.track.reference));
    return this.downloads.savedPlans().filter(p=>p.kind!=='track'&&p.tracks.some(t=>refs.has(t.reference))).map(p=>p.title);
  });
  protected readonly releaseBytes=computed(()=>{
    const target=this.target();if(!target)return 0;
    const refs=target.plan?new Set(this.downloads.exclusiveReferences(target.plan)):null;
    return target.rows.filter(r=>!refs||refs.has(r.track.reference)).reduce((n,r)=>n+r.bytes,0);
  });
  protected readonly storageText=signal('');protected readonly persistent=signal(false);protected readonly persistBusy=signal(false);
  private readonly dialog=viewChild<ElementRef<HTMLDialogElement>>('confirm');
  private parentStates:Array<ReturnType<typeof this.state>>=[];
  protected readonly bytes=bytesLabel;
  protected formatRetry(value:number):string{return new Date(value).toLocaleString();}
  constructor(){void this.estimate();void this.downloads.refresh();}
  protected setView(view:string):void{this.state.set({view,query:'',sort:'title',page:0,detail:''});this.parentStates=[];this.artistTracks.set(false);this.clearSelection();}
  protected search(query:string):void{this.state.update(s=>({...s,query,page:0}));this.clearSelection();}
  protected sort(sort:string):void{this.state.update(s=>({...s,sort,page:0}));}
  protected movePage(delta:number):void{this.state.update(s=>({...s,page:this.page()+delta}));}
  protected open(group:DownloadGroup):void{this.parentStates.push(this.state());this.state.update(s=>({...s,detail:`${group.kind}:${group.id}`,query:'',page:0,sort:group.plan?'saved':'title'}));this.artistTracks.set(false);this.clearSelection();}
  protected back():void{this.state.set(this.parentStates.pop()??{...this.state(),detail:'',page:0,sort:'title'});this.artistTracks.set(false);this.clearSelection();}
  protected clearSelection():void{this.selected.set(new Set());}
  protected toggle(reference:string):void{this.selected.update(s=>{const next=new Set(s);next.has(reference)?next.delete(reference):next.add(reference);return next;});}
  protected select(all=false):void{this.selected.set(new Set((all?this.rows():this.pageRows()).map(r=>r.track.reference)));}
  protected count(group:DownloadGroup):string{return group.total===null?`${group.ready} canciones descargadas`:`${group.ready} de ${group.total} descargadas`;}
  protected async estimate():Promise<void> {
    try {
      const [space,persisted]=await Promise.all([navigator.storage.estimate(),navigator.storage.persisted()]);this.persistent.set(persisted);
      this.storageText.set(space.quota!==undefined&&space.usage!==undefined?`${bytesLabel(Math.max(0,space.quota-space.usage))} disponibles aproximadamente para este sitio`:'El navegador no informa cuánto espacio queda.');
    }catch{this.storageText.set('No pudimos consultar el espacio disponible.');}
  }
  protected async persist():Promise<void> {
    this.persistBusy.set(true);
    try{const granted=await navigator.storage.persist();this.persistent.set(granted);if(!granted)this.storageText.set('El navegador no concedió protección. No se han borrado archivos; puede liberar espacio bajo presión.');}
    catch{this.storageText.set('No pudimos solicitar protección del almacenamiento.');}finally{this.persistBusy.set(false);}
  }
  protected async audit():Promise<void>{await this.downloads.refresh(true);await this.estimate();}
  protected askRemove(rows:LocalDownload[],plan:DownloadPlan|null=null):void {
    this.target.set({rows,plan});this.actionError.set('');
    setTimeout(()=>{const dialog=this.dialog()?.nativeElement;dialog?.showModal();dialog?.querySelector<HTMLButtonElement>('[data-cancel]')?.focus();});
  }
  protected askPlan(plan:DownloadPlan):void{const refs=new Set(plan.tracks.map(t=>t.reference));this.askRemove(this.downloads.visibleRecords().filter(r=>refs.has(r.track.reference)),plan);}
  protected cancel(event?:Event):void{if(this.deleting()){event?.preventDefault();return;}this.dialog()?.nativeElement.close();this.target.set(null);}
  protected async remove():Promise<void> {
    const target=this.target();if(!target||this.deleting())return;this.deleting.set(true);
    try {
      if(target.plan)await this.downloads.removePlan(target.plan);
      else for(const row of target.rows)await this.downloads.remove(row.track.reference,row.owner);
      this.dialog()?.nativeElement.close();this.target.set(null);this.clearSelection();await this.estimate();
    }catch(error){this.actionError.set(downloadMessage(error));}finally{this.deleting.set(false);}
  }
}
