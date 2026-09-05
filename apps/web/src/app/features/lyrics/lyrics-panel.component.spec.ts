import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type { Track } from '@hirmos/contracts';
import { PlaybackSyncService } from '../../core/playback-sync.service';
import { findActiveLyricLine, LyricsPanelComponent } from './lyrics-panel.component';

const track: Track = {
  id: 'track-a', title: 'Canción', artist: 'Artista', artistId: null,
  album: 'Álbum', albumId: null, durationMs: 180_000, coverUrl: null,
  year: null, favorite: false,
};

describe('findActiveLyricLine', () => {
  const lines = [
    { startMs: 1_000, text: 'Primera' },
    { startMs: null, text: 'Nota' },
    { startMs: 2_000, text: 'Segunda' },
    { startMs: 3_000, text: 'Tercera' },
  ];

  it('returns only the last line reached by the playback clock', () => {
    expect(findActiveLyricLine(lines, 999)).toBe(-1);
    expect(findActiveLyricLine(lines, 1_500)).toBe(0);
    expect(findActiveLyricLine(lines, 2_500)).toBe(2);
    expect(findActiveLyricLine(lines, 20_000)).toBe(3);
  });
});

describe('LyricsPanelComponent', () => {
  const playback = {
    currentPositionSeconds: vi.fn(() => 2.5),
    seek: vi.fn(async () => undefined),
  };

  beforeEach(async () => {
    vi.useFakeTimers();
    playback.currentPositionSeconds.mockReturnValue(2.5);
    playback.seek.mockClear();
    await TestBed.configureTestingModule({
      imports: [LyricsPanelComponent],
      providers: [
        provideHttpClient(), provideHttpClientTesting(),
        { provide: PlaybackSyncService, useValue: playback },
      ],
    }).compileComponents();
  });

  afterEach(() => {
    TestBed.inject(HttpTestingController).verify();
    vi.useRealTimers();
  });

  it('marks one current line and seeks through the central playback service', () => {
    const fixture = TestBed.createComponent(LyricsPanelComponent);
    fixture.componentRef.setInput('track', track);
    fixture.componentRef.setInput('open', true);
    fixture.detectChanges();

    TestBed.inject(HttpTestingController).expectOne('/api/music/tracks/track-a/lyrics').flush({
      adjustmentMs: 0,
      lyrics: [{
        displayArtist: 'Artista', displayTitle: 'Canción', language: 'es', synced: true,
        lines: [
          { startMs: 1_000, text: 'Primera' },
          { startMs: 2_000, text: 'Segunda' },
          { startMs: 3_000, text: 'Tercera' },
        ],
      }],
    });
    fixture.detectChanges();
    vi.advanceTimersByTime(101);
    fixture.detectChanges();

    const current = fixture.nativeElement.querySelectorAll('[aria-current="true"]');
    expect(current).toHaveLength(1);
    expect(current[0].textContent).toContain('Segunda');

    (fixture.nativeElement.querySelector('[data-lyric-index="2"]') as HTMLButtonElement).click();
    expect(playback.seek).toHaveBeenCalledWith(3);
  });

  it('reloads lyrics when the song changes while the panel remains open', () => {
    const fixture = TestBed.createComponent(LyricsPanelComponent);
    fixture.componentRef.setInput('track', track);
    fixture.componentRef.setInput('open', true);
    fixture.detectChanges();
    const http = TestBed.inject(HttpTestingController);
    http.expectOne('/api/music/tracks/track-a/lyrics').flush({ lyrics: [], adjustmentMs: 0 });
    fixture.detectChanges();

    fixture.componentRef.setInput('track', { ...track, id: 'track-b', title: 'Otra' });
    fixture.detectChanges();
    http.expectOne('/api/music/tracks/track-b/lyrics').flush({ lyrics: [], adjustmentMs: 0 });
  });

  it('pauses automatic following after manual scroll and can resume it', () => {
    const fixture = TestBed.createComponent(LyricsPanelComponent);
    fixture.componentRef.setInput('track', track);
    fixture.componentRef.setInput('open', true);
    fixture.detectChanges();
    TestBed.inject(HttpTestingController).expectOne('/api/music/tracks/track-a/lyrics').flush({
      adjustmentMs: 0,
      lyrics: [{
        displayArtist: null, displayTitle: null, language: null, synced: true,
        lines: [{ startMs: 1_000, text: 'Primera' }],
      }],
    });
    fixture.detectChanges();

    const scroll = fixture.nativeElement.querySelector('.lyrics-scroll') as HTMLElement;
    scroll.dispatchEvent(new WheelEvent('wheel'));
    fixture.detectChanges();
    const follow = fixture.nativeElement.querySelector('.lyrics-follow') as HTMLButtonElement;
    expect(follow.textContent).toContain('Seguir letra');
    follow.click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.lyrics-follow')).toBeNull();
  });

  it('persists timing adjustments for the current user track', () => {
    const fixture = TestBed.createComponent(LyricsPanelComponent);
    fixture.componentRef.setInput('track', track);
    fixture.componentRef.setInput('open', true);
    fixture.detectChanges();
    const http = TestBed.inject(HttpTestingController);
    http.expectOne('/api/music/tracks/track-a/lyrics').flush({
      adjustmentMs: 0,
      lyrics: [{
        displayArtist: null, displayTitle: null, language: null, synced: true,
        lines: [{ startMs: 1_000, text: 'Primera' }],
      }],
    });
    fixture.detectChanges();

    (fixture.nativeElement.querySelector(
      '[aria-label="Adelantar letra 100 milisegundos"]',
    ) as HTMLButtonElement).click();
    const request = http.expectOne('/api/music/tracks/track-a/lyrics-adjustment');
    expect(request.request.method).toBe('PUT');
    expect(request.request.body).toEqual({ adjustmentMs: 100 });
    request.flush({ adjustmentMs: 100 });
  });

  it('progressively fills a timed word within the current line', () => {
    const fixture = TestBed.createComponent(LyricsPanelComponent);
    fixture.componentRef.setInput('track', track);
    fixture.componentRef.setInput('open', true);
    fixture.detectChanges();
    TestBed.inject(HttpTestingController).expectOne('/api/music/tracks/track-a/lyrics').flush({
      adjustmentMs: 0,
      lyrics: [{
        displayArtist: null, displayTitle: null, language: 'es', synced: true,
        lines: [{
          startMs: 2_000, endMs: 3_000, text: 'Segunda línea',
          words: [{ startMs: 2_000, endMs: 3_000, text: 'Segunda línea' }],
        }],
      }],
    });
    fixture.detectChanges();
    vi.advanceTimersByTime(101);
    fixture.detectChanges();

    const word = fixture.nativeElement.querySelector('.lyrics-word') as HTMLElement;
    expect(word.style.getPropertyValue('--word-progress')).toBe('50%');
  });
});
