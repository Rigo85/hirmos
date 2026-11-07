import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { PlaybackSyncService } from '../core/playback-sync.service';
import { PlaybackFailuresComponent } from './playback-failures.component';
import { AudioPermissionComponent } from './audio-permission.component';

describe('incident and permission presentation', () => {
  afterEach(() => TestBed.resetTestingModule());
  function setup(phase = 'error', code = 'decode') {
    const playback = {
      snapshot: signal({ renderPhase: phase, currentTrackRef:'track', activeFailureId:undefined as string|null|undefined,
        failures:[{ id:'one', code, trackRef:'track', outcome:'paused',
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

  it('never promotes a legacy omission into an alert when another song loads or buffers', () => {
    const {playback,fixture,root}=setup('loading','timeout');
    const s=playback.snapshot();
    for (const phase of ['loading','playing','buffering','paused','loading']) {
      playback.snapshot.set({...s,renderPhase:phase,currentTrackRef:'other',
        failures:[{...s.failures[0],outcome:'advanced'}]}); fixture.detectChanges();
      expect(root.querySelector('section')).toBeNull();
    }
    fixture.componentRef.setInput('history',true); playback.failureDetailsOpen.set(true); fixture.detectChanges();
    expect(root.querySelectorAll('li')).toHaveLength(1);
    expect(root.textContent).toContain('Registro anterior');
  });

  it('shows a fresh omission only while explicitly active, with no resurrection after recovery or reload', () => {
    const {playback,fixture,root}=setup('loading','timeout');
    const s=playback.snapshot();
    playback.snapshot.set({...s,currentTrackRef:'successor',activeFailureId:'one',
      failures:[{...s.failures[0],outcome:'advanced'}]}); fixture.detectChanges();
    expect(root.querySelector('section')).not.toBeNull();
    expect(root.textContent).not.toContain('Reintentar pista actual');
    for(const phase of ['playing','buffering','paused','loading']) {
      playback.snapshot.update(s=>({...s,renderPhase:phase,activeFailureId:null})); fixture.detectChanges();
      expect(root.querySelector('section')).toBeNull();
    }
    fixture.destroy();
    const restored=TestBed.createComponent(PlaybackFailuresComponent); restored.detectChanges();
    expect(restored.nativeElement.querySelector('section')).toBeNull();
    playback.snapshot.update(s=>({...s,activeFailureId:'two',failures:[...s.failures,{...s.failures[0],id:'two'}]}));
    restored.detectChanges(); expect(restored.nativeElement.querySelector('section')).not.toBeNull();
  });

  it('explicitly resolved or missing IDs never fall back to the last incident, even on the same track', () => {
    const {playback,fixture,root}=setup();
    for(const id of [null,'not-in-history']) {
      playback.snapshot.update(s=>({...s,activeFailureId:id})); fixture.detectChanges();
      expect(root.querySelector('section')).toBeNull();
    }
    playback.snapshot.update(s=>({...s,activeFailureId:'one'})); fixture.detectChanges();
    expect(root.textContent).toContain('Reintentar pista actual');
  });

  it('access renewal does not duplicate notices or hide an unrelated decode failure', () => {
    const {playback,fixture,root}=setup();
    playback.authenticationRequired.set(true); fixture.detectChanges();
    expect(root.querySelector('a')).toBeNull();
    expect(root.textContent).not.toContain('Renovar acceso');
    expect(root.textContent).toContain('Falló el audio');
    playback.authenticationRequired.set(false); playback.unconfirmedFailure.set({code:'decode'}); fixture.detectChanges();
    expect(root.textContent).toContain('pendiente de confirmar');
    root.querySelector('button')!.click(); expect(playback.retryFailureReport).toHaveBeenCalledOnce();
  });

  it('leaves confirmed session-expiry presentation to the access notice', () => {
    const {playback,fixture,root}=setup('blocked','authentication');
    playback.authenticationRequired.set(true); fixture.detectChanges();
    expect(root.querySelector('section')).toBeNull();
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
