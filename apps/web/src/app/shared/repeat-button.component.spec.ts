import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { RepeatButtonComponent } from './repeat-button.component';
import { PlaybackSyncService } from '../core/playback-sync.service';

describe('repeat control', () => {
  it('cycles acknowledged state, exposes mode and disables duplicate requests', async () => {
    const state = signal({ repeatMode:'off' });
    const playback = {snapshot:state,connected:signal(true),repeatPending:signal(false),setRepeat:vi.fn()};
    await TestBed.configureTestingModule({imports:[RepeatButtonComponent],
      providers:[{provide:PlaybackSyncService,useValue:playback}]}).compileComponents();
    const f=TestBed.createComponent(RepeatButtonComponent);f.detectChanges();
    const button=f.nativeElement.querySelector('button') as HTMLButtonElement;
    expect(button.getAttribute('aria-label')).toBe('Repetición desactivada');
    button.click();expect(playback.setRepeat).toHaveBeenLastCalledWith('all');
    expect(button.getAttribute('aria-pressed')).toBe('false');
    state.set({repeatMode:'all'});f.detectChanges();
    expect(button.getAttribute('aria-label')).toBe('Repetir toda la cola');
    button.click();expect(playback.setRepeat).toHaveBeenLastCalledWith('one');
    state.set({repeatMode:'one'});f.componentRef.setInput('showLabel',true);f.detectChanges();
    expect(button.textContent).toContain('Repetir pista');
    button.click();expect(playback.setRepeat).toHaveBeenLastCalledWith('off');
    playback.repeatPending.set(true);f.detectChanges();expect(button.disabled).toBe(true);
    playback.repeatPending.set(false);playback.connected.set(false);f.detectChanges();expect(button.disabled).toBe(true);
  });
});
