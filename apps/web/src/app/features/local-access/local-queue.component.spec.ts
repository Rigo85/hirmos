import {signal} from '@angular/core';
import {TestBed} from '@angular/core/testing';
import {LocalQueueComponent} from './local-queue.component';
import {DownloadsService} from '../../offline/downloads.service';
import {OfflinePlaybackService} from '../../offline/offline-playback.service';
import {emptyOfflineQueue,editOfflineQueue,type OfflineQueue,type OfflineQueueEdit} from '../../offline/offline-queue';
function setup(count=4){
  const refs=Array.from({length:count},(_,i)=>`r${i}`),state=signal<OfflineQueue>({...emptyOfflineQueue('owner'),queue:refs,order:refs,current:refs[0],revision:10});
  const player={state,audio:{requested:signal(false)},error:signal(''),opening:signal(false),select:vi.fn(),shuffle:vi.fn(),
    edit:vi.fn(async(edit:OfflineQueueEdit,revision:number)=>{if(state().revision!==revision)return false;state.set(editOfflineQueue(state(),edit));return true;})};
  TestBed.configureTestingModule({imports:[LocalQueueComponent],providers:[{provide:OfflinePlaybackService,useValue:player},
    {provide:DownloadsService,useValue:{records:signal(refs.map(reference=>({track:{reference,title:reference,artist:'Test'}})))}}]});
  const f=TestBed.createComponent(LocalQueueComponent);f.detectChanges();
  const click=async(label:string)=>{const b=[...f.nativeElement.querySelectorAll('button')].find((b:any)=>b.textContent.trim()===label||b.getAttribute('aria-label')===label) as HTMLButtonElement;expect(b).toBeTruthy();b.click();await f.whenStable();f.detectChanges();};
  return {f,player,click};
}
afterEach(()=>TestBed.resetTestingModule());
it('requires confirmation only for current/clear-upcoming and uses the captured revision',async()=>{
  const {f,player,click}=setup();await click('Quitar r0 de la cola');expect(player.edit).not.toHaveBeenCalled();
  expect(f.nativeElement.textContent).toContain('¿Quitar la actual?');player.state.update(s=>({...s,revision:11}));await click('Confirmar');
  expect(player.edit).toHaveBeenCalledWith({action:'remove',references:['r0']},10);expect(player.state().current).toBe('r0');
  await click('Vaciar siguientes');await click('Confirmar');expect(player.state().order).toEqual(['r0']);
});
it('queue play selects the same queue and renders only 50 upcoming rows from 5000',async()=>{
  const {f,player,click}=setup(5000);expect(f.nativeElement.querySelectorAll('.copy')).toHaveLength(51);
  await click('Reproducir r0');expect(player.select).toHaveBeenCalledWith('r0',10);
  await click('Siguiente');expect(f.nativeElement.querySelectorAll('.copy')).toHaveLength(51);
  expect(f.nativeElement.textContent).toContain('51–100 de 4999');
});
it('all history stays accessible in bounded pages without mixing it with upcoming',async()=>{
  const {f,player,click}=setup(5000);player.state.update(s=>({...s,current:'r4999'}));f.detectChanges();
  await click('Mostrar anteriores (4999)');expect(f.nativeElement.querySelectorAll('.copy')).toHaveLength(51);
  expect(f.nativeElement.textContent).toContain('4950–4999 de 4999');await click('Más antiguas');
  expect(f.nativeElement.textContent).toContain('4900–4949 de 4999');expect(f.nativeElement.querySelectorAll('.copy')).toHaveLength(51);
});
