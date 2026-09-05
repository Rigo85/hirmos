import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import type { Track } from '@hirmos/contracts';
import { PlaybackSyncService } from '../../core/playback-sync.service';
import { AlbumComponent } from './album.component';
import { of } from 'rxjs';

describe('AlbumComponent', () => {
  const selectContext = vi.fn();

  beforeEach(async () => {
    selectContext.mockReset();
    await TestBed.configureTestingModule({
      imports: [AlbumComponent],
      providers: [
        provideHttpClient(), provideHttpClientTesting(), provideRouter([]),
        { provide: ActivatedRoute, useValue: { paramMap: of(convertToParamMap({ id: 'album-id' })) } },
        { provide: PlaybackSyncService, useValue: {
          snapshot: () => null, selectContext,
        } },
      ],
    }).compileComponents();
  });

  it('offers ordered and one-context random playback without changing the album', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const fixture = TestBed.createComponent(AlbumComponent);
    fixture.detectChanges();
    TestBed.inject(HttpTestingController).expectOne('/api/library/albums/album-id')
      .flush(album());
    await fixture.whenStable(); fixture.detectChanges();

    const buttons = fixture.nativeElement.querySelectorAll('.genre-actions button') as NodeListOf<HTMLButtonElement>;
    expect([...buttons].map((button) => button.textContent?.trim()))
      .toEqual(['Reproducir álbum', 'Aleatorio']);

    buttons[0]!.click();
    expect(selectContext).toHaveBeenLastCalledWith(
      expect.arrayContaining([expect.objectContaining({ id: 'one' })]), 0, 'album', 'album-id',
    );
    buttons[1]!.click();
    expect(selectContext).toHaveBeenLastCalledWith(
      [expect.objectContaining({ id: 'two' }), expect.objectContaining({ id: 'three' }), expect.objectContaining({ id: 'one' })],
      0, 'album', 'album-id',
    );
    expect(album().tracks.map((track) => track.id)).toEqual(['one', 'two', 'three']);
    vi.restoreAllMocks();
  });
});

function album() {
  return {
    id: 'album-id', name: 'Album', artist: 'Artist', artistId: null, coverUrl: null,
    songCount: 3, durationMs: 540_000, year: 2026, genre: 'Rock', genres: ['Rock'],
    favorite: false, playCount: null, lastPlayedAt: null,
    tracks: [track('one'), track('two'), track('three')],
  };
}

function track(id: string): Track {
  return {
    id, title: id, artist: 'Artist', artistId: null, album: 'Album', albumId: 'album-id',
    durationMs: 180_000, coverUrl: null, year: 2026, genres: ['Rock'], favorite: false,
  };
}
