import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { AudioPlayerService } from '../../core/audio-player.service';
import { PlaybackSyncService } from '../../core/playback-sync.service';
import { SessionStore } from '../../core/session.store';
import { PlayerShellComponent } from './player-shell.component';
import { FavoritesService } from '../../core/favorites.service';

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
            currentPositionSeconds: vi.fn(() => 0),
          },
        },
        {
          provide: FavoritesService,
          useValue: {
            error: signal(null), isFavorite: () => false, isPending: () => false,
            toggle: vi.fn(),
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

  it('offers complete mobile drawer dismissal and restores page scrolling', () => {
    const fixture = TestBed.createComponent(PlayerShellComponent);
    fixture.detectChanges();
    const menu = fixture.nativeElement.querySelector('.menu-button') as HTMLButtonElement;
    const sidebar = fixture.nativeElement.querySelector('.sidebar') as HTMLElement;

    menu.click();
    fixture.detectChanges();

    expect(sidebar.classList).toContain('sidebar--open');
    expect(menu.getAttribute('aria-expanded')).toBe('true');
    expect(document.body.style.overflow).toBe('hidden');
    expect(fixture.nativeElement.querySelector('.sidebar-mobile-close')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('.mobile-menu-backdrop')).not.toBeNull();

    (fixture.nativeElement.querySelector('.mobile-menu-backdrop') as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(sidebar.classList).not.toContain('sidebar--open');
    expect(document.body.style.overflow).toBe('');

    menu.click();
    fixture.detectChanges();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    fixture.detectChanges();

    expect(sidebar.classList).not.toContain('sidebar--open');
    expect(document.body.style.overflow).toBe('');
  });

  it('opens the mobile Now Playing view and commits an interactive seek', () => {
    const player = TestBed.inject(AudioPlayerService) as unknown as {
      track: WritableSignal<Record<string, unknown>>;
    };
    const playback = TestBed.inject(PlaybackSyncService) as unknown as {
      snapshot: WritableSignal<Record<string, unknown> | null>;
      seek: ReturnType<typeof vi.fn>;
      currentPositionSeconds: ReturnType<typeof vi.fn>;
    };
    player.track.set({
      id: 'track-mobile', title: 'Silent Lucidity', artist: 'Queensrÿche',
      artistId: null, album: 'Empire', albumId: null, durationMs: 120_000, coverUrl: null,
    });
    playback.snapshot.set({ currentTrackRef: null, positionMs: 30_000, status: 'paused' });
    playback.currentPositionSeconds.mockReturnValue(30);
    const historyBack = vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
    const fixture = TestBed.createComponent(PlayerShellComponent);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.mobile-player-progress span').style.width)
      .toBe('25%');
    (fixture.nativeElement.querySelector('.mobile-player-open') as HTMLButtonElement).click();
    fixture.detectChanges();

    const dialog = fixture.nativeElement.querySelector('.mobile-now-playing') as HTMLElement;
    const slider = dialog.querySelector('[aria-label="Posición de reproducción"]') as HTMLInputElement;
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(document.body.style.overflow).toBe('hidden');
    expect(slider.max).toBe('120');

    slider.value = '45';
    slider.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(dialog.querySelector('.mobile-now-playing__progress time')?.textContent).toBe('0:45');
    slider.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    expect(playback.seek).toHaveBeenCalledWith(45);

    (dialog.querySelector('.mobile-now-playing__close') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.mobile-now-playing')).toBeNull();
    expect(document.body.style.overflow).toBe('');
    expect(historyBack).toHaveBeenCalledOnce();
  });

  it('opens lyrics above the mobile Now Playing view', () => {
    const player = TestBed.inject(AudioPlayerService) as unknown as {
      track: WritableSignal<Record<string, unknown>>;
    };
    player.track.set({
      id: 'track-mobile', title: 'Silent Lucidity', artist: 'Queensrÿche',
      artistId: null, album: 'Empire', albumId: null, durationMs: 120_000, coverUrl: null,
    });
    const fixture = TestBed.createComponent(PlayerShellComponent);
    fixture.detectChanges();
    (fixture.nativeElement.querySelector('.mobile-player-open') as HTMLButtonElement).click();
    fixture.detectChanges();

    const lyricsButton = fixture.nativeElement.querySelector(
      '.mobile-now-playing__actions button:first-child',
    ) as HTMLButtonElement;
    lyricsButton.click();
    fixture.detectChanges();

    const lyricsPanel = fixture.nativeElement.querySelector('.lyrics-panel') as HTMLElement;
    expect(lyricsPanel.classList).toContain('lyrics-panel--open');
    expect(lyricsPanel.classList).toContain('lyrics-panel--mobile-fullscreen');

    TestBed.inject(HttpTestingController).expectOne(
      '/api/music/tracks/track-mobile/lyrics',
    ).flush({ lyrics: [], availability: 'not_found', adjustmentMs: 0 });
    fixture.detectChanges();
    expect(lyricsPanel.textContent).toContain('Esta canción no tiene letra disponible.');

    (lyricsPanel.querySelector('[aria-label="Cerrar letra"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(lyricsPanel.classList).not.toContain('lyrics-panel--open');
    window.dispatchEvent(new PopStateEvent('popstate'));
    fixture.detectChanges();
  });

  it('closes mobile Now Playing when browser history moves back', () => {
    const player = TestBed.inject(AudioPlayerService) as unknown as {
      track: WritableSignal<Record<string, unknown>>;
    };
    player.track.set({
      id: 'track-mobile', title: 'Silent Lucidity', artist: 'Queensrÿche',
      artistId: null, album: 'Empire', albumId: null, durationMs: 120_000, coverUrl: null,
    });
    const fixture = TestBed.createComponent(PlayerShellComponent);
    fixture.detectChanges();
    (fixture.nativeElement.querySelector('.mobile-player-open') as HTMLButtonElement).click();
    fixture.detectChanges();

    window.dispatchEvent(new PopStateEvent('popstate'));
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.mobile-now-playing')).toBeNull();
    expect(document.body.style.overflow).toBe('');
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
