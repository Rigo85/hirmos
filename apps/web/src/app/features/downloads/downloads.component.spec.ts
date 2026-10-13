import { computed,signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { DownloadsService } from '../../offline/downloads.service';
import type { LocalDownload } from '../../offline/local-downloads';
import type { DownloadPlan } from '../../offline/download-plans';
import { DownloadsComponent } from './downloads.component';
import { SessionStore } from '../../core/session.store';
import { LocalExtrasService } from '../../offline/local-extras.service';

const rows=(n:number):LocalDownload[]=>Array.from({length:n},(_,i)=>({version:1,owner:'owner',fileId:String(i),state:'ready',bytes:12,
  fingerprint:null,contentType:'audio/flac',savedAt:'2026-10-02',track:{reference:String(i),title:`Tema ${String(i).padStart(4,'0')}`,
  album:'Álbum largo',artist:'Artista',albumId:'album',artistId:'artist'}}));
async function view(n=5000){
  const records=signal(rows(n));const plans=signal<DownloadPlan[]>([]);
  const service={records,plans,savedPlans:plans,usable:signal(true),ready:computed(()=>new Set(records().filter(r=>r.state==='ready').map(r=>r.track.reference))),usedBytes:()=>n*12,
    libraryState:signal({view:'albums',query:'',sort:'title',page:0,detail:''}),legacyCount:()=>0,loading:()=>false,error:signal(''),
    extrasRevision:()=>0,extrasBusy:()=>false,extrasIssue:()=>'',extrasProgress:()=>'',extrasResult:()=>'',
    refresh:vi.fn(),canDownload:()=>true,progress:()=>null,activePlan:()=>null,queued:()=>[],completed:()=>0};
  await TestBed.configureTestingModule({imports:[DownloadsComponent],providers:[provideRouter([]),{provide:DownloadsService,useValue:service},
    {provide:SessionStore,useValue:{localOwner:()=>null}},{provide:LocalExtrasService,useValue:{cover:async()=>null}}]}).compileComponents();
  const f=TestBed.createComponent(DownloadsComponent);f.detectChanges();await f.whenStable();return {f,service};
}
function click(f:any,text:string){const button=[...f.nativeElement.querySelectorAll('button')].find((b:any)=>b.textContent.trim()===text||(b.closest('.tabs')&&b.firstChild?.textContent.trim()===text)) as HTMLButtonElement;expect(button).toBeTruthy();button.click();f.detectChanges();}
function counts(f:any):string[]{return [...f.nativeElement.querySelectorAll('.tabs button span')].map((s:any)=>s.textContent.trim());}
it('bounds a 5000 song library to 50 rows, searches the whole set and distinguishes selection scopes',async()=>{
  const {f}=await view();click(f,'Canciones');expect(f.nativeElement.querySelectorAll('.tracks li')).toHaveLength(50);
  expect(counts(f)).toEqual(['1','1','0','5000']);
  click(f,'Seleccionar página');expect(f.nativeElement.textContent).toContain('50 seleccionadas');
  click(f,'Seleccionar 5000 resultados');expect(f.nativeElement.textContent).toContain('5000 seleccionadas');
  click(f,'Siguiente');expect(f.nativeElement.querySelectorAll('.tracks li')).toHaveLength(50);
  expect(f.nativeElement.querySelector('.tracks').textContent).toContain('Tema 0050');
  expect(counts(f)).toEqual(['1','1','0','5000']);
  const input=f.nativeElement.querySelector('input[type=search]');input.value='4999';input.dispatchEvent(new Event('input'));f.detectChanges();
  expect(f.nativeElement.querySelectorAll('.tracks li')).toHaveLength(1);expect(f.nativeElement.textContent).toContain('Tema 4999');
  expect(f.nativeElement.textContent).not.toContain('5000 seleccionadas');
  expect(counts(f)).toEqual(['1','1','0','5000']);
});
it('shows unknown totals until the account inventory is usable, then real zeroes',async()=>{
  const {f,service}=await view(0);service.usable.set(false);f.detectChanges();
  expect(counts(f)).toEqual(['…','…','…','…']);
  service.usable.set(true);f.detectChanges();expect(counts(f)).toEqual(['0','0','0','0']);
});
it('counts incomplete selections but only ready unique files and updates after reconciliation',async()=>{
  const {f,service}=await view(2);
  const base:DownloadPlan={version:1,owner:'owner',id:'playlist:a',kind:'playlist',sourceRef:'a',title:'A',revision:1,
    createdAt:'2026-10-02',requestId:'request',tracks:service.records().map(r=>r.track)};
  service.plans.set([base,{...base,id:'playlist:b',sourceRef:'b'},
    {...base,id:'album:pending',kind:'album',sourceRef:'pending'},
    {...base,id:'playlist:removed',sourceRef:'removed',removal:'removed'}]);
  f.detectChanges();expect(counts(f)).toEqual(['2','1','2','2']);
  service.records.update(rs=>rs.map(r=>({...r,state:'missing' as const})));f.detectChanges();
  expect(counts(f)).toEqual(['1','0','2','0']);
  service.plans.set([]);f.detectChanges();expect(counts(f)).toEqual(['0','0','0','0']);
  service.usable.set(false);f.detectChanges();expect(counts(f)).toEqual(['…','…','…','…']);
});
it('groups files without inventing a saved selection and restores the filter after opening details',async()=>{
  const {f,service}=await view(500);const input=f.nativeElement.querySelector('input[type=search]');
  input.value='album';input.dispatchEvent(new Event('input'));f.detectChanges();
  expect(f.nativeElement.querySelectorAll('.music-card')).toHaveLength(1);
  f.nativeElement.querySelector('.music-card').click();f.detectChanges();
  expect(f.nativeElement.textContent).toContain('Agrupación de tus archivos');expect(f.nativeElement.querySelectorAll('.tracks li')).toHaveLength(50);
  click(f,'← Volver');expect(service.libraryState().query).toBe('album');expect(service.plans()).toEqual([]);
});
it('does not command playback or start downloads when browsing; management stays secondary',async()=>{
  const {f}=await view(4);expect(f.nativeElement.querySelector('[aria-label=Almacenamiento]')).toBeNull();
  click(f,'Transferencias');expect(f.nativeElement.textContent).toContain('No hay transferencias pendientes');
  click(f,'Artistas');expect(f.nativeElement.querySelectorAll('.music-card')).toHaveLength(1);
});
it('adds filtered or selected downloads to local queue without requesting playback',async()=>{
  const {f}=await view(4);f.componentRef.setInput('localOnly',true);f.detectChanges();click(f,'Canciones');
  const append=vi.fn(),play=vi.fn();f.componentInstance.queueLocal.subscribe(append);f.componentInstance.playLocal.subscribe(play);
  click(f,'Añadir a cola');expect(append.mock.calls[0][0]).toHaveLength(4);expect(play).not.toHaveBeenCalled();
  const input=f.nativeElement.querySelector('input[type=search]');input.value='0003';input.dispatchEvent(new Event('input'));f.detectChanges();
  click(f,'Seleccionar página');click(f,'Añadir seleccionadas a cola');expect(append.mock.calls[1][0]).toHaveLength(1);
  expect(append.mock.calls[1][0][0].title).toBe('Tema 0003');expect(play).not.toHaveBeenCalled();
});
