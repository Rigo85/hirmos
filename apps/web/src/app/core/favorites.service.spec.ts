import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type { Track } from '@hirmos/contracts';
import { FavoritesService } from './favorites.service';

describe('FavoritesService', () => {
  beforeEach(() => TestBed.configureTestingModule({
    providers: [provideHttpClient(), provideHttpClientTesting()],
  }));

  it('updates optimistically and keeps the confirmed personal state', async () => {
    const service = TestBed.inject(FavoritesService);
    const http = TestBed.inject(HttpTestingController);
    const result = service.toggle(track());

    expect(service.isFavorite(track())).toBe(true);
    const request = http.expectOne('/api/library/tracks/track-id/favorite');
    expect(request.request.method).toBe('PUT');
    expect(request.request.body).toEqual({ favorite: true });
    request.flush({ reference: 'track-id', favorite: true });

    await expect(result).resolves.toBe(true);
    expect(service.isFavorite(track())).toBe(true);
    expect(service.error()).toBeNull();
  });

  it('rolls back and reports a failed mutation', async () => {
    const service = TestBed.inject(FavoritesService);
    const http = TestBed.inject(HttpTestingController);
    const result = service.toggle(track());
    http.expectOne('/api/library/tracks/track-id/favorite').flush({}, { status: 502, statusText: 'Bad gateway' });

    await expect(result).resolves.toBeNull();
    expect(service.isFavorite(track())).toBe(false);
    expect(service.error()).toContain('favoritos');
  });
});

function track(): Track {
  return {
    id: 'track-id', title: 'Song', artist: 'Artist', artistId: null, album: 'Album',
    albumId: null, durationMs: 180_000, coverUrl: null, year: 2026, genres: [], favorite: false,
  };
}
