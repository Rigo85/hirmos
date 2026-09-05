import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type { Track } from '@hirmos/contracts';
import { PlaybackSyncService } from '../../core/playback-sync.service';
import { FavoritesComponent } from './favorites.component';

describe('FavoritesComponent', () => {
  const selectContext = vi.fn();

  beforeEach(async () => {
    selectContext.mockReset();
    await TestBed.configureTestingModule({
      imports: [FavoritesComponent],
      providers: [
        provideHttpClient(), provideHttpClientTesting(),
        { provide: PlaybackSyncService, useValue: {
          snapshot: () => null, selectContext,
        } },
      ],
    }).compileComponents();
  });

  it('loads the personal list and reproduces it as a favorite context', async () => {
    const fixture = TestBed.createComponent(FavoritesComponent);
    fixture.detectChanges();
    TestBed.inject(HttpTestingController).expectOne((request) =>
      request.url === '/api/library/favorites' && request.params.get('limit') === '50',
    ).flush({ tracks: [track('one'), track('two')], nextCursor: null });
    await fixture.whenStable(); fixture.detectChanges();

    expect(fixture.nativeElement.querySelectorAll('.track-row')).toHaveLength(2);
    (fixture.nativeElement.querySelector('.primary-button') as HTMLButtonElement).click();
    await fixture.whenStable();
    expect(selectContext).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ id: 'one' })]),
      0, 'favorites', 'favorites',
    );
  });

  it('removes a track from the visible list after unmarking it', async () => {
    const fixture = TestBed.createComponent(FavoritesComponent);
    fixture.detectChanges();
    const http = TestBed.inject(HttpTestingController);
    http.expectOne((request) => request.url === '/api/library/favorites')
      .flush({ tracks: [track('one')], nextCursor: null });
    await fixture.whenStable(); fixture.detectChanges();

    (fixture.nativeElement.querySelector('.track-row__favorite') as HTMLButtonElement).click();
    http.expectOne('/api/library/tracks/one/favorite')
      .flush({ reference: 'one', favorite: false });
    await fixture.whenStable(); fixture.detectChanges();

    expect(fixture.nativeElement.querySelectorAll('.track-row')).toHaveLength(0);
    expect(fixture.nativeElement.querySelector('.empty-state')).not.toBeNull();
  });
});

function track(id: string): Track {
  return {
    id, title: `Song ${id}`, artist: 'Artist', artistId: null, album: 'Album', albumId: null,
    durationMs: 180_000, coverUrl: null, year: 2026, genres: [], favorite: true,
  };
}
