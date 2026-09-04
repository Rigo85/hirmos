import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { signal, type WritableSignal } from '@angular/core';
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
        provideHttpClient(), provideHttpClientTesting(),
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
            phase: signal('paused'),
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
            currentPositionSeconds: () => 0,
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

  it('toggles the queue from the player bar and exposes its pressed state', () => {
    const fixture = TestBed.createComponent(PlayerShellComponent);
    fixture.detectChanges();
    const panel = fixture.nativeElement.querySelector('.queue-panel') as HTMLElement;
    let toggle = fixture.nativeElement.querySelector(
      '.player-actions [aria-label="Mostrar cola"]',
    ) as HTMLButtonElement;

    toggle.click();
    fixture.detectChanges();

    expect(panel.classList).toContain('queue-panel--open');
    toggle = fixture.nativeElement.querySelector(
      '.player-actions [aria-label="Cerrar cola"]',
    ) as HTMLButtonElement;
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    toggle.click();
    fixture.detectChanges();

    expect(panel.classList).not.toContain('queue-panel--open');
    expect(fixture.nativeElement.querySelector('.player-actions [aria-label="Mostrar cola"]')
      .getAttribute('aria-pressed')).toBe('false');
  });

  it('toggles lyrics from the player bar after loading them', async () => {
    const player = TestBed.inject(AudioPlayerService) as unknown as {
      track: WritableSignal<{ id: string; title: string; coverUrl: null }>;
    };
    player.track.set({ id: 'track-a', title: 'Song', coverUrl: null });
    const fixture = TestBed.createComponent(PlayerShellComponent);
    fixture.detectChanges();
    const http = TestBed.inject(HttpTestingController);
    const panel = fixture.nativeElement.querySelector('.lyrics-panel') as HTMLElement;

    (fixture.nativeElement.querySelector(
      '.player-actions [aria-label="Mostrar letra"]',
    ) as HTMLButtonElement).click();
    fixture.detectChanges();
    http.expectOne('/api/music/tracks/track-a/lyrics').flush({ lyrics: [], adjustmentMs: 0 });
    await fixture.whenStable();
    fixture.detectChanges();

    expect(panel.classList).toContain('lyrics-panel--open');
    const toggle = fixture.nativeElement.querySelector(
      '.player-actions [aria-label="Cerrar letra"]',
    ) as HTMLButtonElement;
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    toggle.click();
    fixture.detectChanges();

    expect(panel.classList).not.toContain('lyrics-panel--open');
  });
});
