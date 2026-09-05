import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import type { ArtistDetail, Track } from '@hirmos/contracts';
import { of } from 'rxjs';
import { PlaybackSyncService } from '../../core/playback-sync.service';
import { ArtistComponent } from './artist.component';

describe('ArtistComponent', () => {
  const selectContext = vi.fn();

  beforeEach(async () => {
    selectContext.mockReset();
    await TestBed.configureTestingModule({
      imports: [ArtistComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        {
          provide: ActivatedRoute,
          useValue: { paramMap: of(convertToParamMap({ id: 'artist-id' })) },
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
