import { provideHttpClient } from '@angular/common/http';
import { signal } from '@angular/core';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute,convertToParamMap,provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { PlaybackSyncService } from '../../core/playback-sync.service';
import { PlaylistsComponent } from './playlists.component';
describe('personal playlists',()=>{
  const play=vi.fn();let http:HttpTestingController;
  beforeEach(async()=>{play.mockReset();await TestBed.configureTestingModule({imports:[PlaylistsComponent],providers:[
    provideHttpClient(),provideHttpClientTesting(),provideRouter([]),
    {provide:ActivatedRoute,useValue:{paramMap:of(convertToParamMap({id:'list'}))}},
    {provide:PlaybackSyncService,useValue:{selectPlaylist:play,snapshot:signal(null),toggle:vi.fn(),editQueue:vi.fn()}},
  ]}).compileComponents();http=TestBed.inject(HttpTestingController);});
  afterEach(()=>http.verify());
  async function view(){const f=TestBed.createComponent(PlaylistsComponent);f.detectChanges();
    http.expectOne(r=>r.url==='/api/playlists/list').flush(page());await f.whenStable();f.detectChanges();return f;}
  it('plays server version rather than only loaded rows',async()=>{const f=await view();
    const button=[...f.nativeElement.querySelectorAll('button')].find((b:any)=>b.textContent.includes('Reproducir toda')) as HTMLButtonElement;
    button.click();expect(play).toHaveBeenCalledWith('list',7,null,false);
    expect(f.nativeElement.textContent).toContain('5000 canciones');
    expect(f.nativeElement.querySelectorAll('.playlist-items li')).toHaveLength(2);
  });
  it('addresses a duplicated track by playlist item id',async()=>{const f=await view();
    const buttons=f.nativeElement.querySelectorAll('.playlist-items button');buttons[1].click();
    expect(play).toHaveBeenCalledWith('list',7,'item-b',false);
  });
  it('pauses only the exact playing occurrence, not another copy of the same track',async()=>{
    const f=await view();const playback=TestBed.inject(PlaybackSyncService);
    playback.snapshot.set({status:'playing',currentQueueItemId:'q1',queue:[{id:'q1',trackRef:'same-track',contextRef:'list',playlistItemId:'item-a'}]} as any);
    f.detectChanges();const buttons=f.nativeElement.querySelectorAll('.playlist-items button');
    expect(buttons[0].getAttribute('aria-label')).toBe('Pausar Song');expect(buttons[1].getAttribute('aria-label')).toBe('Reproducir Song');
    buttons[0].click();expect(playback.toggle).toHaveBeenCalledOnce();buttons[1].click();expect(play).toHaveBeenCalledWith('list',7,'item-b',false);
  });
  it('removes selected occurrence without controlling audio; stale response is visible',async()=>{const f=await view();
    const checkbox=f.nativeElement.querySelector('.playlist-items input[type=checkbox]');checkbox.click();f.detectChanges();
    [...f.nativeElement.querySelectorAll('button')].find((b:any)=>b.textContent.trim()==='Quitar').click();
    const request=http.expectOne('/api/playlists/commands');expect(request.request.body).toMatchObject({action:'remove',itemIds:['item-a'],expectedRevision:7});
    request.flush({message:'La playlist cambió en otro dispositivo.'},{status:409,statusText:'Conflict'});
    await f.whenStable();f.detectChanges();expect(f.nativeElement.querySelector('[role=alert]').textContent).toContain('cambió');
    expect(play).not.toHaveBeenCalled();expect(f.nativeElement.querySelectorAll('.playlist-items li')).toHaveLength(2);
  });
  it('resumes the exact saved queue occurrence without replacing the playlist context',async()=>{
    const f=TestBed.createComponent(PlaylistsComponent);f.detectChanges();const data=page();
    (data.items[0] as any).originQueueItemId='original-q';
    http.expectOne(r=>r.url==='/api/playlists/list').flush(data);await f.whenStable();
    const playback=TestBed.inject(PlaybackSyncService);
    playback.snapshot.set({status:'paused',currentQueueItemId:'original-q',queue:[{id:'original-q',trackRef:'same-track',contextRef:'album'}]} as any);
    f.detectChanges();const buttons=f.nativeElement.querySelectorAll('.playlist-items button');
    buttons[0].click();expect(playback.toggle).toHaveBeenCalledWith('original-q');expect(play).not.toHaveBeenCalled();
    buttons[1].click();expect(play).toHaveBeenCalledWith('list',7,'item-b',false);
    expect(f.nativeElement.querySelectorAll('.playlist-current')).toHaveLength(1);
    playback.snapshot.set({status:'playing',currentQueueItemId:'new-q',queue:[{id:'new-q',trackRef:'same-track',contextRef:'other'}]} as any);
    f.detectChanges();expect(f.nativeElement.querySelectorAll('.playlist-current')).toHaveLength(0);
  });
  it('keeps search mounted and uses a single contextual action region on selection',async()=>{
    const f=await view();const search=f.nativeElement.querySelector('input[type=search]');
    f.nativeElement.querySelector('.playlist-items input[type=checkbox]').click();f.detectChanges();
    expect(f.nativeElement.querySelector('input[type=search]')).toBe(search);
    expect(f.nativeElement.querySelector('.selection-actions').textContent).toContain('1 seleccionada');
    expect(f.nativeElement.querySelector('.selection-actions').textContent).not.toContain('1 seleccionadas');
    expect(f.nativeElement.querySelector('.selection-actions').textContent).toContain('Mover');
    expect(f.nativeElement.querySelector('details').open).toBe(false);
  });
  it('requires confirmation before deleting the saved playlist',async()=>{const f=await view();
    [...f.nativeElement.querySelectorAll('button')].find((b:any)=>b.textContent==='Eliminar playlist').click();f.detectChanges();
    http.expectNone('/api/playlists/commands');expect(f.nativeElement.textContent).toContain('No borra archivos');expect(play).not.toHaveBeenCalled();
  });
});
function page(){return {playlist:{id:'list',name:'My list',description:'Private',count:5000,durationMs:600000000,covers:[],revision:7},nextOffset:100,
  items:['item-a','item-b'].map((id,ordinal)=>({id,ordinal,availability:'available',track:{id:'same-track',title:'Song',artist:'Artist',album:'Album',artistId:null,albumId:null,durationMs:1000,coverUrl:null,year:null,genres:[],favorite:false}}))};}
