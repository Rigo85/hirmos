import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { PlaybackSyncService } from '../core/playback-sync.service';
import { PlaybackFailuresComponent } from './playback-failures.component';
import { AudioPermissionComponent } from './audio-permission.component';

describe('incident and permission presentation', () => {
  afterEach(() => TestBed.resetTestingModule());
  function setup(phase = 'error', code = 'decode') {
    const playback = {
      snapshot: signal({ renderPhase: phase, currentTrackRef:'track', failures:[{ id:'one', code, trackRef:'track',
        phase:'start', occurredAt:new Date().toISOString() }] }),
      unconfirmedFailure:signal<unknown>(null), authenticationRequired:signal(false), ownsLease:vi.fn(()=>true),
      dismissedFailure:signal<string|null>(null), failureDetailsOpen:signal(false), failureText:()=> 'Falló el audio.',
      retryCurrent:vi.fn(), retryFailureReport:vi.fn(), claimHere:vi.fn(), next:vi.fn(),
      retryWaitSeconds:signal(0),
      waitingForAudio:signal(phase==='awaiting_interaction'), permissionStillBlocked:signal(false),
      continuingAudio:signal(false), connected:signal(true), hasActiveRemotePlayer:vi.fn(()=>false), continueAudio:vi.fn(),
    };
    TestBed.configureTestingModule({imports:[PlaybackFailuresComponent,AudioPermissionComponent],
      providers:[{provide:PlaybackSyncService,useValue:playback}]});
    const fixture=TestBed.createComponent(PlaybackFailuresComponent); fixture.detectChanges();
    return {playback,fixture,root:fixture.nativeElement as HTMLElement};
  }

  it('closing removes the whole alert; history remains accessible only in its separate view', () => {
    const {playback,fixture,root}=setup();
    const click=(label:string)=> [...root.querySelectorAll('button')].find(b=>b.textContent?.includes(label))!.click();
    click('Reintentar'); expect(playback.retryCurrent).toHaveBeenCalledOnce();
    click('Cerrar aviso'); fixture.detectChanges();
    expect(root.querySelector('section')).toBeNull();
    expect(root.textContent?.trim()).toBe('');
    expect(playback.snapshot().failures).toHaveLength(1);
    fixture.componentRef.setInput('history',true); fixture.detectChanges();
    click('Incidencias'); fixture.detectChanges();
    expect(root.querySelectorAll('li')).toHaveLength(1);
    expect(root.querySelector('[role="status"]')).toBeNull();
  });

  it('new incident is visible after closing an earlier one', () => {
    const {playback,fixture,root}=setup();
    playback.dismissedFailure.set('one'); fixture.detectChanges();
    expect(root.querySelector('section')).toBeNull();
    const s=playback.snapshot(); playback.snapshot.set({...s,failures:[{...s.failures[0],id:'two'}]}); fixture.detectChanges();
    expect(root.querySelector('section')).not.toBeNull();
  });

  it('shows cooldown inline, blocks retry until expiry and still allows closing everything', () => {
    const {playback,fixture,root}=setup('blocked','service_unavailable');
    playback.retryWaitSeconds.set(10); fixture.detectChanges();
    const retry=[...root.querySelectorAll('button')].find(b=>b.textContent?.includes('Reintentar'))!;
    expect(retry.disabled).toBe(true);
    retry.click(); expect(playback.retryCurrent).not.toHaveBeenCalled();
    expect(root.querySelector('[role="timer"]')?.textContent).toContain('10 s');
    expect(root.querySelector('[role="alert"]')).toBeNull();
    playback.retryWaitSeconds.set(0); fixture.detectChanges();
    expect(retry.disabled).toBe(false);
    expect(root.querySelector('[role="timer"]')).toBeNull();
    retry.click(); expect(playback.retryCurrent).toHaveBeenCalledOnce();
    playback.retryWaitSeconds.set(5); fixture.detectChanges();
    [...root.querySelectorAll('button')].find(b=>b.textContent?.includes('Cerrar aviso'))!.click();
    fixture.detectChanges(); expect(root.textContent?.trim()).toBe('');
  });

  it.each(['playing','paused','awaiting_interaction'])('old history is not an active alert in %s', phase => {
    const {root}=setup(phase);
    expect(root.querySelector('section')).toBeNull();
  });

  it('legacy autoplay is not shown in alerts or incident history', () => {
    const {fixture,root}=setup('blocked','autoplay');
    expect(root.textContent?.trim()).toBe('');
    fixture.componentRef.setInput('history',true); fixture.detectChanges();
    expect(root.textContent?.trim()).toBe('');
  });

  it('still offers authentication and unconfirmed-failure recovery', () => {
    const {playback,fixture,root}=setup();
    playback.authenticationRequired.set(true); fixture.detectChanges();
    expect(root.querySelector('a')?.getAttribute('href')).toBe('/login');
    playback.authenticationRequired.set(false); playback.unconfirmedFailure.set({code:'decode'}); fixture.detectChanges();
    expect(root.textContent).toContain('pendiente de confirmar');
    root.querySelector('button')!.click(); expect(playback.retryFailureReport).toHaveBeenCalledOnce();
  });

  it.each(['local','remote','expired'])('permission waiting has the right neutral action for %s', kind => {
    const {playback}=setup('awaiting_interaction');
    playback.ownsLease.mockReturnValue(kind==='local'); playback.hasActiveRemotePlayer.mockReturnValue(kind==='remote');
    const fixture=TestBed.createComponent(AudioPermissionComponent); fixture.detectChanges();
    const root:HTMLElement=fixture.nativeElement;
    expect(root.querySelector('[role="alert"]')).toBeNull();
    expect(root.textContent).toContain(kind==='local' ? 'Pulsa para continuar' : kind==='remote' ? 'El otro dispositivo' : 'está en espera');
    root.querySelector('button')!.click();
    expect(kind==='remote' ? playback.claimHere : playback.continueAudio).toHaveBeenCalledOnce();
    playback.waitingForAudio.set(false); fixture.detectChanges(); expect(root.textContent?.trim()).toBe('');
  });
});
