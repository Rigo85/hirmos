import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import type { PlaylistCommand, PlaylistItem, PlaylistSummary } from '@hirmos/contracts';
import { PlaylistsService, playlistError } from '../../core/playlists.service';
import { PlaybackSyncService } from '../../core/playback-sync.service';
import { AppIconComponent } from '../../shared/app-icon.component';

@Component({selector:'app-playlists',imports:[FormsModule,RouterLink,AppIconComponent],
  templateUrl:'./playlists.component.html',styleUrl:'./playlists.component.scss'})
export class PlaylistsComponent {
  protected readonly service=inject(PlaylistsService);
  protected readonly playback=inject(PlaybackSyncService);
  private readonly route=inject(ActivatedRoute);
  private readonly router=inject(Router);
  private readonly destroy=inject(DestroyRef);
  protected readonly lists=signal<PlaylistSummary[]>([]);
  protected readonly playlist=signal<PlaylistSummary|null>(null);
  protected readonly currentItemId=computed(()=>{
    const s=this.playback.snapshot();const current=s?.queue.find(i=>i.id===s.currentQueueItemId);
    if(!current)return null;
    const exact=current.contextRef===this.playlist()?.id?current.playlistItemId:null;
    return this.items().find(i=>i.id===exact)?.id??this.items().find(i=>
      i.originQueueItemId===current.id && i.track.id===current.trackRef)?.id??null;
  });
  protected playing(id:string):boolean{return id===this.currentItemId()&&this.playback.snapshot()?.status==='playing';}
  protected readonly items=signal<PlaylistItem[]>([]);
  protected readonly filter=signal('');
  protected readonly filtered=computed(()=>this.items());
  private filterTimer:ReturnType<typeof setTimeout>|null=null;
  protected search(value:string):void{this.filter.set(value);this.generation++;if(this.filterTimer)clearTimeout(this.filterTimer);this.filterTimer=setTimeout(()=>void this.load(),250);}
  protected readonly selected=signal<Set<string>>(new Set());
  protected readonly allVisibleSelected=computed(()=>this.items().length>0&&this.items().every(i=>this.selected().has(i.id)));
  protected toggleVisible():void{if(this.allVisibleSelected())this.clearSelection();else this.selectVisible();}
  protected clearSelection():void{this.selected.set(new Set());}
  protected readonly busy=signal(false); protected readonly loading=signal(false);
  protected readonly error=signal(''); protected readonly message=signal('');
  protected readonly nextOffset=signal<number|null>(null);
  protected readonly editing=signal(false); protected readonly deleting=signal(false);
  protected name=''; protected description=''; protected moveTarget='';
  private id:string|null=null; private generation=0; private dragging:string|null=null;
  constructor(){this.destroy.onDestroy(()=>{this.generation++;if(this.filterTimer)clearTimeout(this.filterTimer);});this.route.paramMap.pipe(takeUntilDestroyed(this.destroy)).subscribe(params=>{
    if(this.filterTimer)clearTimeout(this.filterTimer);
    this.id=params.get('id');this.filter.set('');this.selected.set(new Set());this.playlist.set(null);this.items.set([]);
    this.editing.set(false);this.deleting.set(false);void this.load();
  });}
  protected async load(offset=0):Promise<void>{
    const generation=++this.generation, id=this.id; this.loading.set(true);this.error.set('');
    try {
      if(id){const page=await this.service.page(id,offset,offset?this.playlist()?.revision:undefined,this.filter());
        if(generation!==this.generation)return;
        this.playlist.set(page.playlist);this.items.update(old=>offset?[...old,...page.items]:page.items);this.nextOffset.set(page.nextOffset);
        if(!offset){this.selected.set(new Set());this.moveTarget='';}
      }else{const result=await this.service.list();if(generation===this.generation)this.lists.set(result.playlists);}
    }catch(e){if(generation===this.generation)this.error.set(playlistError(e));}
    finally{if(generation===this.generation)this.loading.set(false);}
  }
  protected toggle(id:string):void{this.selected.update(old=>{const next=new Set(old);next.has(id)?next.delete(id):next.add(id);return next;});}
  protected selectVisible():void{this.selected.set(new Set(this.filtered().map(i=>i.id)));}
  protected edit():void{const p=this.playlist();this.name=p?.name??'';this.description=p?.description??'';this.editing.set(true);}
  protected async save():Promise<void>{
    const p=this.playlist();if(!this.name.trim())return;
    await this.run(p?{action:'rename',playlistId:p.id,expectedRevision:p.revision,name:this.name.trim(),description:this.description,commandId:crypto.randomUUID()}
      :{action:'create',name:this.name.trim(),description:this.description,commandId:crypto.randomUUID()},true);
  }
  protected async duplicate():Promise<void>{const p=this.playlist();if(!p)return;
    await this.run({action:'duplicate',playlistId:p.id,expectedRevision:p.revision,name:`${p.name.slice(0,110)} (copia)`,commandId:crypto.randomUUID()},true);
  }
  protected async removePlaylist():Promise<void>{const p=this.playlist();if(!p)return;
    await this.run({action:'delete',playlistId:p.id,expectedRevision:p.revision,commandId:crypto.randomUUID()});
    if(!this.error())await this.router.navigate(['/playlists']);
  }
  protected async removeItems():Promise<void>{const p=this.playlist();if(!p || !this.selected().size)return;
    await this.run({action:'remove',playlistId:p.id,expectedRevision:p.revision,itemIds:[...this.selected()],commandId:crypto.randomUUID()});
  }
  protected async move(ids=[...this.selected()],beforeId:string|null=this.moveTarget||null):Promise<void>{const p=this.playlist();if(!p||!ids.length)return;
    await this.run({action:'move',playlistId:p.id,expectedRevision:p.revision,itemIds:ids,beforeId,commandId:crypto.randomUUID()});
  }
  protected dragStart(event:DragEvent,id:string):void{if(this.filter() || this.busy()){event.preventDefault();return;}this.dragging=id;event.dataTransfer?.setData('text/plain',id);}
  protected drop(event:DragEvent,id:string):void{event.preventDefault();const from=this.dragging;this.dragging=null;if(from&&from!==id&&!this.filter())void this.move([from],id);}
  protected play(itemId:string|null=null,shuffle=false):void{const p=this.playlist();if(itemId&&itemId===this.currentItemId()){const id=this.playback.snapshot()?.currentQueueItemId;if(id)void this.playback.toggle(id);return;}if(p)void this.playback.selectPlaylist(p.id,p.revision,itemId,shuffle);}
  protected async confirmMove(dialog:HTMLDialogElement):Promise<void>{await this.move();if(!this.error())dialog.close();}
  protected addToQueue():void{const p=this.playlist();if(p)void this.playback.editQueue({action:'add-playlist',placement:'queue',playlistId:p.id,playlistRevision:p.revision});}
  protected duration(ms:number):string{const minutes=Math.round(ms/60000);return minutes>=60?`${Math.floor(minutes/60)} h ${minutes%60} min`:`${minutes} min`;}
  protected availability(item:PlaylistItem):string{return item.availability==='missing'?'Ya no está en la biblioteca':item.availability==='source_unavailable'?'Fuente no disponible':'Pendiente de confirmar en catálogo';}
  private async run(command:PlaylistCommand,navigate=false):Promise<void>{
    if(this.busy())return;this.busy.set(true);this.error.set('');this.message.set('');
    try{const result=await this.service.command(command);this.editing.set(false);this.deleting.set(false);
      if(navigate&&result.playlistId!==this.id)await this.router.navigate(['/playlists',result.playlistId]);
      else if(command.action!=='delete')await this.load();
      this.message.set('Cambios guardados. La cola que está sonando no se modificó.');
    }catch(e){this.error.set(playlistError(e));}finally{this.busy.set(false);}
  }
}
