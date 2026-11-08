import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import type { ArtistDetail, Track } from '@hirmos/contracts';
import { BehaviorSubject } from 'rxjs';
import { PlaybackSyncService } from '../../core/playback-sync.service';
import { ArtistComponent } from './artist.component';

describe('ArtistComponent', () => {
  const selectContext = vi.fn();
  let route: BehaviorSubject<ReturnType<typeof convertToParamMap>>;

  beforeEach(async () => {
    selectContext.mockReset();
    route = new BehaviorSubject(convertToParamMap({ id: 'artist-id' }));
    await TestBed.configureTestingModule({
      imports: [ArtistComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        {
          provide: ActivatedRoute,
          useValue: { paramMap: route },
        },
        {
          provide: PlaybackSyncService,
          useValue: {
            selectContext,
            snapshot: signal({ currentTrackRef: null, status: 'paused' }),
            toggle: vi.fn(),
          },
        },
      ],
    }).compileComponents();
  });

  it('renders the complete popular-track list inside its scrollable viewport and plays it as context', async () => {
    const fixture = TestBed.createComponent(ArtistComponent);
    fixture.detectChanges();
    const http = TestBed.inject(HttpTestingController);
    http
      .expectOne('/api/library/artists/artist-id')
      .flush(artistWithPopularTracks(8));
    await fixture.whenStable();
    http.expectOne('/api/library/artists/artist-id/genres').flush({
      genres: [
        { name: 'Rock', browsable: true, reference: 'rock' },
        { name: 'Grunge', browsable: false, reference: null },
      ],
    });
    await fixture.whenStable();
    fixture.detectChanges();

    expect(popularTrackButtons(fixture.nativeElement)).toHaveLength(8);
    expect(fixture.nativeElement.querySelector('.popular-tracks-count').textContent)
      .toContain('8 canciones');
    expect(fixture.nativeElement.querySelector('.popular-tracks-toggle')).toBeNull();
    expect(fixture.nativeElement.querySelectorAll('.artist-hero .tag-list a')).toHaveLength(1);
    expect(fixture.nativeElement.querySelectorAll('.artist-hero .tag-list span')).toHaveLength(1);

    popularTrackButtons(fixture.nativeElement)[6].click();
    expect(selectContext).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ id: 'track-8' })]),
      6,
      'artist',
      'artist-id',
    );
  });
  for (const lateError of [false, true]) {
    it(`ignores stale artist ${lateError ? 'failure' : 'success'} after navigating`, async () => {
      const fixture = TestBed.createComponent(ArtistComponent);
      fixture.detectChanges();
      const http = TestBed.inject(HttpTestingController);
      const old = http.expectOne('/api/library/artists/artist-id');
      route.next(convertToParamMap({ id: 'second' }));
      http.expectOne('/api/library/artists/second').flush({ ...artistWithPopularTracks(0), id: 'preferred', name: 'Current artist', songCount: 126 });
      await fixture.whenStable();
      http.expectOne('/api/library/artists/preferred/genres').flush({ genres: [] });
      if (lateError) old.flush({}, { status: 503, statusText: 'Unavailable' });
      else old.flush(artistWithPopularTracks(0));
      await fixture.whenStable();fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('h1').textContent).toBe('Current artist');
      expect(fixture.nativeElement.querySelector('.artist-hero .muted').textContent).toContain('126 canciones');
      expect(fixture.nativeElement.querySelector('.form-error')).toBeNull();
      http.verify();
    });
  }
  it('does not invent zero songs before a catalog count is available', async () => {
    const fixture = TestBed.createComponent(ArtistComponent);fixture.detectChanges();
    const http = TestBed.inject(HttpTestingController);
    http.expectOne('/api/library/artists/artist-id').flush(artistWithPopularTracks(0));
    await fixture.whenStable();
    http.expectOne('/api/library/artists/artist-id/genres').flush({ genres: [] });
    await fixture.whenStable();fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.artist-hero .muted').textContent).not.toContain('0 canciones');
    expect(fixture.nativeElement.textContent).toContain('No hay álbumes atribuidos');
  });
  it('ignores a late detail after destroying the view', async () => {
    const fixture = TestBed.createComponent(ArtistComponent);fixture.detectChanges();
    const http = TestBed.inject(HttpTestingController);
    const pending = http.expectOne('/api/library/artists/artist-id');
    fixture.destroy();pending.flush(artistWithPopularTracks(0));
    await fixture.whenStable();http.expectNone('/api/library/artists/artist-id/genres');
  });

});

function popularTrackButtons(root: HTMLElement): HTMLButtonElement[] {
  return Array.from(root.querySelectorAll<HTMLButtonElement>('#artist-popular-tracks .track-row__title'));
}

function artistWithPopularTracks(count: number): ArtistDetail {
  return {
    id: 'artist-id', name: 'Artista', coverUrl: null, albumCount: 0, favorite: false,
    albums: [], genres: [], biography: null, externalUrl: null, similarArtists: [],
    topTracks: Array.from({ length: count }, (_, index): Track => ({
      id: `track-${index + 1}`,
      title: `Canción ${index + 1}`,
      artist: 'Artista',
      artistId: 'artist-id',
      album: 'Álbum',
      albumId: 'album-id',
      durationMs: 180_000,
      coverUrl: null,
      year: 2026,
      genres: [],
      favorite: false,
    })),
  };
}
