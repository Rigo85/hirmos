import { provideHttpClient } from '@angular/common/http';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { AudioPlayerService } from '../../core/audio-player.service';
import { PlaybackSyncService } from '../../core/playback-sync.service';
import { SessionStore } from '../../core/session.store';
import { PlayerShellComponent } from './player-shell.component';

describe('PlayerShellComponent', () => {
  beforeEach(async () => {
    localStorage.clear();
    await TestBed.configureTestingModule({
      imports: [PlayerShellComponent],
      providers: [
        provideHttpClient(),
        provideRouter([]),
        {
          provide: SessionStore,
          useValue: {
            session: signal({ user: { displayName: 'Oyente', role: 'user' } }),
            logout: vi.fn(),
          },
        },
        {
          provide: AudioPlayerService,
          useValue: {
            track: signal(null), positionSeconds: signal(0), volume: signal(1),
            setVolume: vi.fn(),
          },
        },
        {
          provide: PlaybackSyncService,
          useValue: {
            snapshot: signal(null), connected: signal(true), error: signal(null),
            connect: vi.fn(), disconnect: vi.fn(), trackFor: vi.fn(), ownsLease: () => false,
            hasActiveRemotePlayer: () => false, previous: vi.fn(), next: vi.fn(), toggle: vi.fn(),
            seek: vi.fn(), removeQueueItem: vi.fn(), claimHere: vi.fn(),
          },
        },
      ],
    }).compileComponents();
  });

  it('collapses the desktop sidebar and remembers the browser preference', () => {
    const fixture = TestBed.createComponent(PlayerShellComponent);
    fixture.detectChanges();
    const shell = fixture.nativeElement.querySelector('.app-shell') as HTMLElement;
    const toggle = fixture.nativeElement.querySelector('.sidebar-collapse') as HTMLButtonElement;

    expect(shell.classList.contains('app-shell--sidebar-collapsed')).toBe(false);
    expect(toggle.getAttribute('aria-label')).toBe('Contraer menú lateral');

    toggle.click();
    fixture.detectChanges();

    expect(shell.classList.contains('app-shell--sidebar-collapsed')).toBe(true);
    expect(toggle.getAttribute('aria-label')).toBe('Expandir menú lateral');
    expect(localStorage.getItem('hirmos.sidebar.collapsed')).toBe('true');
    expect(fixture.nativeElement.querySelector('.nav-link').getAttribute('title')).toBe('Inicio');
  });
});
