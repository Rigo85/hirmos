import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type { Track } from '@hirmos/contracts';
import { PlaybackSyncService } from '../../core/playback-sync.service';
import { FavoritesComponent } from './favorites.component';
import {SessionStore} from '../../core/session.store';
import {signal} from '@angular/core';
import {provideRouter} from '@angular/router';
import {DownloadsService} from '../../offline/downloads.service';

describe('FavoritesComponent', () => {
  const selectFavorites = vi.fn();

  beforeEach(async () => {
    selectFavorites.mockReset();
    await TestBed.configureTestingModule({
      imports: [FavoritesComponent],
      providers: [
        provideHttpClient(), provideHttpClientTesting(), provideRouter([]),
        {provide:SessionStore,useValue:{session:signal({user:{id:'synthetic'}}),localOwner:signal('synthetic'),canUseRemote:signal(true),requestGeneration:()=>0}},
        { provide: PlaybackSyncService, useValue: {
          snapshot: () => null, selectFavorites,
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
    expect(selectFavorites).toHaveBeenCalledWith();
    TestBed.inject(HttpTestingController).expectNone(request=>request.params.get('limit')==='500');
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
  it('offers whole-collection downloads separately from playback and visible-page navigation',async()=>{
    const f=TestBed.createComponent(FavoritesComponent);f.detectChanges();
    const http=TestBed.inject(HttpTestingController);
    http.expectOne(r=>r.url==='/api/library/favorites').flush({tracks:[track('one')],nextCursor:'50'});
    await f.whenStable();f.detectChanges();
    const downloads=TestBed.inject(DownloadsService),enqueue=vi.spyOn(downloads,'enqueueFavorites').mockResolvedValue();
    const button=f.nativeElement.querySelector('app-download-button button') as HTMLButtonElement;
    expect(button.textContent).toContain('Descargar originales');button.click();await f.whenStable();f.detectChanges();
    expect(enqueue).toHaveBeenCalledExactlyOnceWith();expect(selectFavorites).not.toHaveBeenCalled();
    expect(f.nativeElement.textContent).toContain('no solo esta página');
    expect(f.nativeElement.querySelector('app-download-button a').getAttribute('href')).toBe('/downloads');
    http.expectNone(r=>r.url==='/api/library/favorites');
  });
});

function track(id: string): Track {
  return {
    id, title: `Song ${id}`, artist: 'Artist', artistId: null, album: 'Album', albumId: null,
    durationMs: 180_000, coverUrl: null, year: 2026, genres: [], favorite: true,
  };
}
