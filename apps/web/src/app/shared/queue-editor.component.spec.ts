import {signal} from '@angular/core';
import {TestBed} from '@angular/core/testing';
import {provideRouter} from '@angular/router';
import {provideHttpClient} from '@angular/common/http';
import {PlaybackSyncService} from '../core/playback-sync.service';
import {QueueEditorComponent} from './queue-editor.component';

describe('queue editing view',()=>{
  let playback:any;
  beforeEach(async()=>{
    playback={snapshot:signal({currentQueueItemId:'0',queueRevision:1,queue:Array.from({length:5000},(_,n)=>({id:String(n),trackRef:`track-${n}`,priority:n>0&&n<3}))}),
      trackFor:()=>({title:'Song',artist:'Artist',album:'Album'}),ensureQueueTracks:vi.fn(),editQueue:vi.fn(async()=>true),toggle:vi.fn()};
    await TestBed.configureTestingModule({imports:[QueueEditorComponent],providers:[provideRouter([]),provideHttpClient(),{provide:PlaybackSyncService,useValue:playback}]}).compileComponents();
  });
  it('renders current plus 100 following entries, not all 5000',()=>{
    const f=TestBed.createComponent(QueueEditorComponent);f.detectChanges();
    expect(f.nativeElement.querySelectorAll('.entries .play')).toHaveLength(101);
    expect(playback.ensureQueueTracks.mock.calls[0][0]).toHaveLength(101);
    expect(f.nativeElement.textContent).toContain('Tus siguientes');expect(f.nativeElement.textContent).toContain('Después');
  });
  it('does not promise repetition of an empty queue',()=>{
    playback.snapshot.set({...playback.snapshot(),currentQueueItemId:null,queue:[],repeatMode:'all'});
    const f=TestBed.createComponent(QueueEditorComponent);f.detectChanges();
    expect(f.nativeElement.textContent).toContain('La cola está vacía');
    expect(f.nativeElement.textContent).not.toContain('Al terminar, volverá');
  });
  it('selects an exact queue occurrence without rebuilding the context',()=>{
    const f=TestBed.createComponent(QueueEditorComponent);f.detectChanges();f.nativeElement.querySelectorAll('.entries .play')[2].click();
    expect(playback.editQueue).toHaveBeenCalledWith({action:'select',itemId:'2'});
  });
  it('requires confirmation to remove the current item',()=>{
    const f=TestBed.createComponent(QueueEditorComponent);f.detectChanges();f.nativeElement.querySelector('.entries .remove').click();f.detectChanges();
    expect(playback.editQueue).not.toHaveBeenCalled();expect(f.nativeElement.textContent).toContain('Quitar actual y seguir');
  });
  it('confirms against the queue shown when the dialog opened, not a later edit',()=>{
    const f=TestBed.createComponent(QueueEditorComponent);f.detectChanges();const original=playback.snapshot();
    const button=(text:string)=>[...f.nativeElement.querySelectorAll('button')].find((b:any)=>b.textContent.trim()===text) as HTMLButtonElement;
    button('Vaciar siguientes').click();f.detectChanges();
    playback.snapshot.set({...original,queueRevision:2});f.detectChanges();
    button('Sí, vaciar siguientes').click();
    expect(playback.editQueue).toHaveBeenCalledWith({action:'clear-upcoming'},original);
  });
  it('does not reclassify previous entries as upcoming after the last current item was removed',()=>{
    playback.snapshot.set({...playback.snapshot(),currentQueueItemId:null,queuePastCount:5000});
    const f=TestBed.createComponent(QueueEditorComponent);f.detectChanges();
    expect(f.nativeElement.querySelectorAll('.entries .play')).toHaveLength(0);
    expect(f.nativeElement.textContent).toContain('Mostrar anteriores en esta cola (5000)');
  });
});
