import { TestBed } from '@angular/core/testing';
import { of,throwError } from 'rxjs';
import type { Track } from '@hirmos/contracts';
import { LYRICS_CONTEXT } from './lyrics-context';
import { LyricsPanelComponent } from './lyrics-panel.component';

function setup(){
  const context={local:true,position:()=>2.5,seek:vi.fn(),adjust:vi.fn((_ref,ms)=>of({adjustmentMs:ms})),
    load:vi.fn(()=>of({availability:'available',adjustmentMs:0,lyrics:[{synced:true,displayTitle:null,displayArtist:null,language:null,
      lines:[{text:'Saved words',startMs:2000,endMs:3000,words:[{text:'Saved words',startMs:2000,endMs:3000}]}]}]}))};
  // Intentionally no HttpClient or online playback coordinator in this injector.
  TestBed.configureTestingModule({imports:[LyricsPanelComponent],providers:[{provide:LYRICS_CONTEXT,useValue:context}]});
  const f=TestBed.createComponent(LyricsPanelComponent);
  f.componentRef.setInput('track',{id:'local-track',title:'Local',artist:'Test',durationMs:180000} as Track);f.componentRef.setInput('open',true);
  return {context,f};
}
afterEach(()=>vi.useRealTimers());
it('uses local words, clock, seek and adjustment through the shared panel without online services',()=>{
  vi.useFakeTimers();const {context,f}=setup();f.detectChanges();vi.advanceTimersByTime(101);f.detectChanges();
  expect(f.nativeElement.textContent).toContain('GUARDADA EN ESTE DISPOSITIVO');
  expect(f.nativeElement.querySelector('.lyrics-word').style.getPropertyValue('--word-progress')).toBe('50%');
  f.nativeElement.querySelector('[data-lyric-index="0"]').click();expect(context.seek).toHaveBeenCalledWith(2);
  f.nativeElement.querySelector('[aria-label="Adelantar letra 100 milisegundos"]').click();
  expect(context.adjust).toHaveBeenCalledWith('local-track',100);
});
it.each(['LOCAL_LYRICS_MISSING','Disk denied'])('distinguishes local absence from reading failure: %s',message=>{
  const {context,f}=setup();context.load.mockImplementation(()=>throwError(()=>new Error(message)));f.detectChanges();
  expect(f.nativeElement.textContent).toContain(message==='LOCAL_LYRICS_MISSING'?'No hay una letra guardada':'No pudimos leer');
});
