import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { Track } from '@hirmos/contracts';
import { TrackRowComponent } from './track-row.component';

describe('TrackRowComponent', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [TrackRowComponent],
      providers: [provideRouter([])],
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
});

function track(): Track {
  return {
    id: 'track-id', title: 'Canción', artist: 'Artista', artistId: 'artist-id',
    album: 'Álbum', albumId: 'album-id', durationMs: 180_000, coverUrl: null,
    year: 2026, favorite: false,
  };
}
