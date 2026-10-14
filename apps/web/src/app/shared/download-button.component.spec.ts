import {signal} from '@angular/core';
import {TestBed} from '@angular/core/testing';
import {provideRouter} from '@angular/router';
import type {Track} from '@hirmos/contracts';
import {DownloadsService} from '../offline/downloads.service';
import {DownloadButtonComponent} from './download-button.component';

describe('DownloadButtonComponent album tile', () => {
  const track = {id:'one',title:'One'} as Track;
  const plans=signal<Array<{id:string;tracks:Array<{reference:string}>}>>([]);
  const ready=signal(new Set<string>());
  const enqueue=vi.fn();
  beforeEach(async()=>{
    plans.set([]);ready.set(new Set());enqueue.mockReset();
    await TestBed.configureTestingModule({imports:[DownloadButtonComponent],providers:[provideRouter([]),
      {provide:DownloadsService,useValue:{savedPlans:plans,ready,canDownload:()=>true,enqueue}}]}).compileComponents();
  });
  function mount(tile=true){
    const fixture=TestBed.createComponent(DownloadButtonComponent);
    fixture.componentRef.setInput('tracks',[track]);
    fixture.componentRef.setInput('album',{id:'album',name:'Album'});
    fixture.componentRef.setInput('mobileTile',tile);fixture.detectChanges();return fixture;
  }
  it('opts in only for album layout; completed downloads still navigate to management',()=>{
    const f=mount(false);expect(f.nativeElement.classList.contains('mobile-tile')).toBe(false);
    f.componentRef.setInput('mobileTile',true);f.detectChanges();
    expect(f.nativeElement.classList.contains('mobile-tile')).toBe(true);
    plans.set([{id:'album:album',tracks:[{reference:'one'}]}]);f.detectChanges();
    expect(f.nativeElement.querySelector('button').textContent.trim()).toBe('Completar descarga');
    ready.set(new Set(['one']));f.detectChanges();
    expect(f.nativeElement.querySelector('button')).toBeNull();
    expect(f.nativeElement.querySelector('a.outline-button').getAttribute('href')).toBe('/downloads');
    expect(f.nativeElement.querySelector('a.outline-button').textContent.trim()).toBe('Descargado');
  });
  it('keeps preparation, feedback and errors outside the action label',async()=>{
    let resolve!:()=>void;
    enqueue.mockImplementationOnce(()=>new Promise<void>(r=>{resolve=r;}));
    const f=mount(); const button=f.nativeElement.querySelector('button') as HTMLButtonElement;
    button.click();f.detectChanges();
    expect(button.disabled).toBe(true);expect(button.textContent?.trim()).toBe('Preparando…');
    resolve();await f.whenStable();f.detectChanges();
    expect(enqueue).toHaveBeenCalledWith([track],'album','album','Album');
    expect(button.querySelector('[role=status]')).toBeNull();
    expect(f.nativeElement.querySelector(':scope > [role=status] a').getAttribute('href')).toBe('/downloads');
    enqueue.mockRejectedValueOnce(new Error('synthetic failure'));
    button.click();await f.whenStable();f.detectChanges();
    expect(f.nativeElement.querySelector(':scope > [role=alert]')).not.toBeNull();
    expect(button.querySelector('[role=alert]')).toBeNull();
    expect(button.disabled).toBe(false);
  });
});
