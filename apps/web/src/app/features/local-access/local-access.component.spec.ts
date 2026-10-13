import {Component,input,output,signal,WritableSignal} from '@angular/core';
import {TestBed} from '@angular/core/testing';
import {By} from '@angular/platform-browser';
import {provideRouter} from '@angular/router';
import {LocalAccessComponent} from './local-access.component';
import {AppIconComponent} from '../../shared/app-icon.component';
import {NgTemplateOutlet} from '@angular/common';
import {PlayerBarComponent} from '../../shared/player-bar.component';
import {NowPlayingComponent} from '../../shared/now-playing.component';
import {RepeatControlComponent} from '../../shared/repeat-control.component';
import {DownloadsService} from '../../offline/downloads.service';
import {OfflinePlaybackService} from '../../offline/offline-playback.service';
import {SessionStore} from '../../core/session.store';
import {LocalExtrasService} from '../../offline/local-extras.service';

@Component({selector:'app-lyrics-panel',template:''})
class LyricsStub {
  open=input(false);mobileFullscreen=input(false);track=input<unknown>();closed=output<void>();
}

@Component({selector:'app-downloads',template:''})
class DownloadsStub {
  localOnly=input(false);currentLocal=input<string|null>(null);localPlaying=input(false);playLocal=output();queueLocal=output();
}
@Component({selector:'app-local-queue',template:''})
class QueueStub {closed=output<void>();}
function setup(){
  const audio={track:signal(null),requested:signal(false),phase:signal('idle'),durationSeconds:signal(0),
    volume:signal(.8),muted:signal(false),setVolume:vi.fn(),toggleMuted:vi.fn()};
  const playback={audio,state:signal({current:'track',queue:['track'],repeat:'off',shuffled:false}),
    opening:signal(false),error:signal(''),inventoryRevision:signal(0),position:signal(42),
    previous:vi.fn(),next:vi.fn(),toggle:vi.fn(),shuffle:vi.fn(),repeat:vi.fn(),seek:vi.fn()};
  const store={localOwner:signal('owner'),local:{value:signal({user:{displayName:'Synthetic'}})},busy:signal(false),renewed:signal(0)};
  const records=signal([{track:{reference:'track',title:'Saved original',artist:'Saved artist',durationMs:180000}}]);
  TestBed.configureTestingModule({imports:[LocalAccessComponent],providers:[provideRouter([]),
    {provide:LocalExtrasService,useValue:{cover:async()=>null}},
    {provide:SessionStore,useValue:store},{provide:DownloadsService,useValue:{records}}]});
  TestBed.overrideComponent(LocalAccessComponent,{set:{imports:[LyricsStub,QueueStub,DownloadsStub,AppIconComponent,NgTemplateOutlet,PlayerBarComponent,NowPlayingComponent,RepeatControlComponent],
    providers:[{provide:OfflinePlaybackService,useValue:playback}]}});
  const fixture=TestBed.createComponent(LocalAccessComponent);fixture.detectChanges();
  return {fixture,playback,records,root:fixture.nativeElement as HTMLElement};
}
afterEach(()=>TestBed.resetTestingModule());
it('toggles the queue in its existing slot, excludes lyrics and closes with Escape',()=>{
  const {root,fixture,playback}=setup();
  root.querySelector<HTMLButtonElement>('footer [aria-label="Mostrar letra"]')!.click();fixture.detectChanges();
  root.querySelector<HTMLButtonElement>('footer [aria-label="Mostrar cola"]')!.click();fixture.detectChanges();
  expect(fixture.debugElement.query(By.directive(QueueStub))).not.toBeNull();
  expect(fixture.debugElement.query(By.directive(LyricsStub)).componentInstance.open()).toBe(false);
  root.querySelector<HTMLButtonElement>('footer [aria-label="Cerrar cola"]')!.click();fixture.detectChanges();
  expect(fixture.debugElement.query(By.directive(QueueStub))).toBeNull();
  root.querySelector<HTMLButtonElement>('footer [aria-label="Mostrar cola"]')!.click();fixture.detectChanges();
  document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));fixture.detectChanges();
  expect(fixture.debugElement.query(By.directive(QueueStub))).toBeNull();expect(playback.toggle).not.toHaveBeenCalled();
});
it('toggles the existing lyrics slot without moving other controls or issuing a playback command',()=>{
  const {root,fixture,playback}=setup();
  root.querySelector<HTMLButtonElement>('footer [aria-label="Mostrar letra"]')!.click();fixture.detectChanges();
  expect(fixture.debugElement.query(By.directive(LyricsStub)).componentInstance.open()).toBe(true);
  root.querySelector<HTMLButtonElement>('footer [aria-label="Cerrar letra"]')!.click();fixture.detectChanges();
  expect(fixture.debugElement.query(By.directive(LyricsStub)).componentInstance.open()).toBe(false);
  expect(playback.toggle).not.toHaveBeenCalled();
});
it('uses the normal three-zone player layout with seek nested under central transport',()=>{
  const {root}=setup(),footer=root.querySelector('.player-bar')!;
  expect(root.querySelector('app-player-bar')).not.toBeNull();
  expect([...footer.children].slice(-3).map(e=>e.className)).toEqual(['player-track','player-controls','player-actions']);
  expect(footer.querySelector('.player-controls .progress [aria-label="Posición offline"]')).not.toBeNull();
  expect(footer.querySelector('.player-actions [aria-label="Volumen de este dispositivo"]')).not.toBeNull();
  expect(footer.querySelector('.mini-cover')).not.toBeNull();
  expect(footer.querySelector('.player-track')?.textContent).toContain('Saved artist');
  expect([...footer.querySelectorAll('time')].map(e=>e.textContent)).toEqual(['0:42','3:00']);
  expect(footer.querySelector('img')).toBeNull(); // no remote cover request
});
it('keeps transport, repeat and mute wired only to the local controller',()=>{
  const {root,playback}=setup();
  for(const [label,method] of [['Anterior','previous'],['Reproducir','toggle'],['Siguiente','next'],
    ['Repetición desactivada','repeat']] as const){
    (root.querySelector(`footer [aria-label="${label}"]`) as HTMLButtonElement).click();
    expect(playback[method]).toHaveBeenCalledOnce();
  }
  (root.querySelector('[aria-label="Silenciar este dispositivo"]') as HTMLButtonElement).click();
  expect(playback.audio.toggleMuted).toHaveBeenCalledOnce();
});
it('shows muted output and pressed local modes without adding text that displaces controls',()=>{
  const {root,playback,fixture}=setup();playback.audio.muted.set(true);
  playback.state.update(s=>({...s,repeat:'one',shuffled:true}));fixture.detectChanges();
  expect(root.querySelector<HTMLInputElement>('[aria-label="Volumen de este dispositivo"]')?.value).toBe('0');
  expect(root.querySelector('[aria-label="Repetir esta pista"]')?.getAttribute('aria-pressed')).toBe('true');
  expect(root.querySelector('[aria-label="Aleatorio local"]')).toBeNull();
});
it('preserves online action slots and explains unavailable offline capabilities without executing commands',()=>{
  const {root,playback,fixture}=setup();
  const icons=fixture.debugElement.queryAll(By.css('.player-actions app-icon')).map(icon=>icon.injector.get(AppIconComponent).name());
  expect(icons).toEqual(['repeat','lyrics','queue','volume']);
  const favorite=root.querySelector<HTMLButtonElement>('.player-track [playerFavorite]')!;
  expect(favorite.disabled).toBe(true);
  expect(favorite.querySelector('app-icon')?.getAttribute('name')).toBe('heart');
  for(const button of root.querySelectorAll<HTMLButtonElement>('button.offline-unavailable')){
    expect(button.disabled).toBe(true);
    expect(button.title).toContain('modo offline');
    expect(button.getAttribute('aria-label')).toBe(button.title);
    button.click();
  }
  expect(playback.toggle).not.toHaveBeenCalled();
  expect(playback.shuffle).not.toHaveBeenCalled();
  expect(playback.repeat).not.toHaveBeenCalled();
  root.querySelector<HTMLButtonElement>('.mobile-player-open')!.click();fixture.detectChanges();
  expect(fixture.debugElement.queryAll(By.css('.mobile-now-playing__actions app-icon')).map(icon=>icon.injector.get(AppIconComponent).name()))
    .toEqual(['repeat','lyrics','queue']);
  expect(root.querySelector('.mobile-now-playing__metadata [playerFavorite]')).not.toBeNull();
  expect(root.querySelector('.offline-capabilities')?.textContent).toContain('todavía no disponibles');
});
it('restores the seek thumb when saved metadata arrives after the local position',()=>{
  const {root,records,fixture}=setup(),saved=records();records.set([]);fixture.detectChanges();
  const seek=root.querySelector<HTMLInputElement>('[aria-label="Posición offline"]')!;
  expect(seek.value).toBe('0');records.set(saved);fixture.detectChanges();
  expect(seek.max).toBe('180');expect(seek.value).toBe('42');
});
it('uses the shared mobile view, seeks locally and restores scrolling on close',()=>{
  const {root,playback,fixture}=setup();
  const back=vi.spyOn(window.history,'back').mockImplementation(()=>undefined);
  (playback.audio.track as WritableSignal<unknown>).set({title:'Saved original',artist:'Saved artist'});
  fixture.detectChanges();
  root.querySelector<HTMLButtonElement>('.mobile-player-open')!.click();fixture.detectChanges();
  expect(root.querySelector('app-now-playing')).not.toBeNull();
  const dialog=root.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(document.body.style.overflow).toBe('hidden');
  expect(dialog.textContent).toContain('Modo offline');
  const slider=dialog.querySelector<HTMLInputElement>('[aria-label="Posición de reproducción"]')!;
  expect(slider.disabled).toBe(false);
  slider.value='65';slider.dispatchEvent(new Event('input'));fixture.detectChanges();
  expect(dialog.querySelector('time')?.textContent).toBe('1:05');
  slider.dispatchEvent(new Event('change'));
  expect(playback.seek).toHaveBeenCalledWith(65);
  dialog.querySelector<HTMLButtonElement>('[aria-label="Reproducir"]')!.click();
  expect(playback.toggle).toHaveBeenCalledOnce();
  dialog.querySelector<HTMLButtonElement>('[aria-label="Cerrar Reproduciendo ahora"]')!.click();
  fixture.detectChanges();
  expect(root.querySelector('[role="dialog"]')).toBeNull();
  expect(document.body.style.overflow).toBe('');
  expect(back).toHaveBeenCalledOnce();back.mockRestore();
});
it('closes the local mobile player on browser Back without stopping audio',()=>{
  const {root,playback,fixture}=setup();
  root.querySelector<HTMLButtonElement>('.mobile-player-open')!.click();fixture.detectChanges();
  window.dispatchEvent(new PopStateEvent('popstate'));fixture.detectChanges();
  expect(root.querySelector('[role="dialog"]')).toBeNull();
  expect(document.body.style.overflow).toBe('');
  expect(playback.toggle).not.toHaveBeenCalled();
});
it('keeps the empty player disabled and the opening state non-interactive',()=>{
  const {root,playback,fixture}=setup();
  playback.opening.set(true);fixture.detectChanges();
  expect(root.querySelector<HTMLButtonElement>('.player-play')!.disabled).toBe(true);
  expect(root.querySelector<HTMLButtonElement>('footer [aria-label="Siguiente"]')!.disabled).toBe(true);
  playback.opening.set(false);
  playback.state.set({current:null as unknown as string,queue:[],repeat:'off',shuffled:false});
  fixture.detectChanges();
  expect(root.querySelector('.mobile-player-open')).toBeNull();
  expect(root.querySelector<HTMLButtonElement>('.player-play')!.disabled).toBe(true);
  expect(root.querySelector<HTMLInputElement>('[aria-label="Posición offline"]')!.disabled).toBe(true);
});
