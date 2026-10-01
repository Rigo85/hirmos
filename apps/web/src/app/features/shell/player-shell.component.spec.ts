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
            setVolume: vi.fn(), muted: signal(false), toggleMuted: vi.fn(),
          },
        },
        {
          provide: PlaybackSyncService,
          useValue: {
            snapshot: signal(null), connected: signal(true), error: signal(null), notice: signal(null), replacement:signal(null),
            ensureQueueTracks:vi.fn(),editQueue:vi.fn(),
            repeatPending:signal(false),setRepeat:vi.fn(),
            unconfirmedFailure: signal(null), authenticationRequired: signal(false),
            waitingForAudio: signal(false),
            retryWaitSeconds: signal(0),
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

  it('labels volume as local output and exposes a mute toggle', () => {
    const fixture = TestBed.createComponent(PlayerShellComponent);
    fixture.detectChanges();
    const player = TestBed.inject(AudioPlayerService);
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('[aria-label="Volumen de este dispositivo"]')).not.toBeNull();
    const button = root.querySelector<HTMLButtonElement>('[aria-label="Silenciar este dispositivo"]')!;
    button.click();
    expect(player.toggleMuted).toHaveBeenCalledOnce();
    player.muted.set(true);
    fixture.detectChanges();
    expect(button.getAttribute('aria-label')).toBe('Activar sonido en este dispositivo');
    expect(button.getAttribute('aria-pressed')).toBe('true');
  });

  it('hides stale local audio when empty, but enables Play for a prepared queue', () => {
    const player = TestBed.inject(AudioPlayerService);
    (player.track as WritableSignal<unknown>).set({ id: 'old', title: 'Removed track', durationMs: 180_000 });
    player.positionSeconds.set(46);
    const playback = TestBed.inject(PlaybackSyncService);
    const state = { currentTrackRef: null, currentQueueItemId: null, status: 'stopped', positionMs: 0,
      queue: [] as { id: string; trackRef: string }[], queuePastCount: 0 };
    (playback.snapshot as WritableSignal<unknown>).set(state);
    const fixture = TestBed.createComponent(PlayerShellComponent); fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('.player-track')?.textContent).not.toContain('Removed track');
    expect(root.querySelector<HTMLButtonElement>('.player-play')!.disabled).toBe(true);
    expect(root.querySelector<HTMLInputElement>('[aria-label="Posición"]')!.disabled).toBe(true);
    expect(root.querySelector('.progress time')?.textContent).toBe('0:00');
    expect(root.querySelector<HTMLButtonElement>('[aria-label="Mostrar letra"]')!.disabled).toBe(true);
    (playback.snapshot as WritableSignal<unknown>).set({ ...state, queue: [{ id: 'first', trackRef: 'new' }] });
    fixture.detectChanges();
    expect(root.querySelector('.player-track')?.textContent).toContain('Cola preparada');
    const play = root.querySelector<HTMLButtonElement>('.player-play')!;
    expect(play.disabled).toBe(false); play.click(); expect(playback.toggle).toHaveBeenCalledOnce();
    (playback.snapshot as WritableSignal<unknown>).set({ ...state, queue: [{ id: 'past', trackRef: 'old' }], queuePastCount: 1 });
    fixture.detectChanges(); expect(play.disabled).toBe(true);
  });

  it('keeps cooldown visible by playback controls without an error toast, including mobile', () => {
    const player=TestBed.inject(AudioPlayerService) as unknown as {track:WritableSignal<Record<string,unknown>>};
    player.track.set({id:'track',title:'Prueba',artist:'Artista',album:'Álbum',durationMs:120_000,coverUrl:null});
    const playback=TestBed.inject(PlaybackSyncService);
    playback.retryWaitSeconds.set(5);
    const fixture=TestBed.createComponent(PlayerShellComponent); fixture.detectChanges();
    const root=fixture.nativeElement as HTMLElement;
    const play=root.querySelector<HTMLButtonElement>('.player-play')!;
    expect(play.disabled).toBe(true);
    expect(root.querySelector('.player-track [role="timer"]')?.textContent).toContain('5 s');
    expect(root.querySelector('[role="alert"]')).toBeNull();
    root.querySelector<HTMLButtonElement>('.mobile-player-open')!.click(); fixture.detectChanges();
    expect(root.querySelector<HTMLButtonElement>('.mobile-now-playing__play')!.disabled).toBe(true);
    expect(root.querySelector('.mobile-now-playing__progress [role="timer"]')?.textContent).toContain('5 s');
    playback.retryWaitSeconds.set(0); fixture.detectChanges();
    expect(play.disabled).toBe(false);
    expect(root.querySelector<HTMLButtonElement>('.mobile-now-playing__play')!.disabled).toBe(false);
    expect(root.querySelector('[role="timer"]')).toBeNull();
    expect(playback.toggle).not.toHaveBeenCalled();
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
    playback.snapshot.set({ currentTrackRef: 'track-mobile', positionMs: 30_000, status: 'paused', queue: [] });
    vi.mocked(TestBed.inject(PlaybackSyncService).trackFor).mockReturnValue(TestBed.inject(AudioPlayerService).track());
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

    const lyricsButton = [...fixture.nativeElement.querySelectorAll('.mobile-now-playing__actions button')]
      .find((button: HTMLButtonElement) => button.textContent?.trim() === 'Letra') as HTMLButtonElement;
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
