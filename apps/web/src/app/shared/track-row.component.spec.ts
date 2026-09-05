import { signal } from '@angular/core';
import { By } from '@angular/platform-browser';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { Track } from '@hirmos/contracts';
import { PlaybackSyncService } from '../core/playback-sync.service';
import { AppIconComponent } from './app-icon.component';
import { TrackRowComponent } from './track-row.component';

describe('TrackRowComponent', () => {
  const snapshot = signal<{ currentTrackRef: string | null; status: 'playing' | 'paused' }>({
    currentTrackRef: null,
    status: 'paused',
  });
  const toggle = vi.fn();

  beforeEach(async () => {
    snapshot.set({ currentTrackRef: null, status: 'paused' });
    toggle.mockReset();
    await TestBed.configureTestingModule({
      imports: [TrackRowComponent],
      providers: [
        provideRouter([]),
        { provide: PlaybackSyncService, useValue: { snapshot, toggle } },
      ],
    }).compileComponents();
  });

  it('links available artist and album metadata without using them as play controls', () => {
    const fixture = TestBed.createComponent(TrackRowComponent);
    fixture.componentRef.setInput('track', track());
    fixture.componentRef.setInput('showCover', true);
    const played = vi.fn();
    fixture.componentInstance.playTrack.subscribe(played);
    fixture.detectChanges();

    const links = fixture.nativeElement.querySelectorAll('.track-row__meta a') as NodeListOf<HTMLAnchorElement>;
    expect(links).toHaveLength(2);
    expect(links[0].getAttribute('href')).toBe('/artists/artist-id');
    expect(links[1].getAttribute('href')).toBe('/albums/album-id');

    fixture.nativeElement.querySelector('.track-row__title').click();
    expect(played).toHaveBeenCalledWith(expect.objectContaining({ id: 'track-id' }));
  });

  it('keeps metadata as text when the source does not provide navigable ids', () => {
    const fixture = TestBed.createComponent(TrackRowComponent);
    fixture.componentRef.setInput('track', { ...track(), artistId: null, albumId: null });
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelectorAll('.track-row__meta a')).toHaveLength(0);
    expect(fixture.nativeElement.querySelector('.track-row__meta').textContent.replace(/\s/g, ''))
      .toBe('Artista·Álbum');
  });

  it('highlights and pauses the current playing track instead of selecting it again', () => {
    snapshot.set({ currentTrackRef: 'track-id', status: 'playing' });
    const fixture = TestBed.createComponent(TrackRowComponent);
    fixture.componentRef.setInput('track', track());
    const played = vi.fn();
    fixture.componentInstance.playTrack.subscribe(played);
    fixture.detectChanges();

    expect(fixture.nativeElement.classList).toContain('track-row--current');
    expect(fixture.nativeElement.classList).toContain('track-row--playing');
    expect(fixture.nativeElement.getAttribute('aria-current')).toBe('true');
    expect(fixture.nativeElement.querySelector('.track-row__play').getAttribute('aria-label'))
      .toBe('Pausar Canción');
    expect(fixture.debugElement.query(By.directive(AppIconComponent)).componentInstance.name())
      .toBe('pause');

    fixture.nativeElement.querySelector('.track-row__play').click();
    expect(toggle).toHaveBeenCalledOnce();
    expect(played).not.toHaveBeenCalled();
  });

  it('keeps a paused current track highlighted and offers play', () => {
    snapshot.set({ currentTrackRef: 'track-id', status: 'paused' });
    const fixture = TestBed.createComponent(TrackRowComponent);
    fixture.componentRef.setInput('track', track());
    fixture.detectChanges();

    expect(fixture.nativeElement.classList).toContain('track-row--current');
    expect(fixture.nativeElement.classList).not.toContain('track-row--playing');
    expect(fixture.nativeElement.querySelector('.track-row__play').getAttribute('aria-label'))
      .toBe('Reproducir Canción');
    expect(fixture.debugElement.query(By.directive(AppIconComponent)).componentInstance.name())
      .toBe('play');
  });
});

function track(): Track {
  return {
    id: 'track-id', title: 'Canción', artist: 'Artista', artistId: 'artist-id',
    album: 'Álbum', albumId: 'album-id', durationMs: 180_000, coverUrl: null,
    year: 2026, genres: [], favorite: false,
  };
}
