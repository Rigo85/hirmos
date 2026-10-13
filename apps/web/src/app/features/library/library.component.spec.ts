import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter, Router } from '@angular/router';
import type { Album } from '@hirmos/contracts';
import { of } from 'rxjs';
import { PlaybackSyncService } from '../../core/playback-sync.service';
import { LibraryComponent } from './library.component';

describe('LibraryComponent', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [LibraryComponent],
      providers: [
        provideHttpClient(), provideHttpClientTesting(), provideRouter([]),
        { provide: ActivatedRoute, useValue: {
          queryParamMap: of(convertToParamMap({})), snapshot: { queryParamMap: convertToParamMap({}) },
        } },
        { provide: PlaybackSyncService, useValue: {
          snapshot: signal({ currentTrackRef: null, status: 'paused' }), select: vi.fn(),
          toggle: vi.fn(),
        } },
      ],
    }).compileComponents();
  });

  it('shows catalog totals and appends the next album page', async () => {
    const fixture = TestBed.createComponent(LibraryComponent);
    fixture.detectChanges();
    const http = TestBed.inject(HttpTestingController);
    http.expectOne('/api/library/stats').flush({
      artists: 82, albums: 589, tracks: 6876, genres: 19,
      ready: true, syncedAt: '2026-09-07T00:00:00.000Z',
    });
    http.expectOne((request) => request.url === '/api/library/albums'
      && request.params.get('limit') === '60' && !request.params.has('cursor'))
      .flush({ albums: [album('one')], nextCursor: '60' });
    await fixture.whenStable();
    fixture.detectChanges();

    const tabs = fixture.nativeElement.querySelectorAll('.library-tabs button');
    expect(tabs[0].textContent).toContain('589');
    expect(tabs[1].textContent).toContain('82');
    expect(tabs[2].textContent).toContain('6876');
    expect(fixture.nativeElement.querySelector('.load-more').textContent).toContain('1 de 589');

    fixture.nativeElement.querySelector('.load-more button').click();
    http.expectOne((request) => request.url === '/api/library/albums'
      && request.params.get('cursor') === '60')
      .flush({ albums: [album('two')], nextCursor: null });
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelectorAll('.album-card')).toHaveLength(2);
    expect(fixture.nativeElement.querySelector('.load-more')).toBeNull();
  });
  it('routes artist, title and cover independently, with no nested links or fake artist route',async()=>{
    const fixture=TestBed.createComponent(LibraryComponent);fixture.detectChanges();
    const http=TestBed.inject(HttpTestingController);
    http.expectOne('/api/library/stats').flush({ready:false});
    http.expectOne(r=>r.url==='/api/library/albums').flush({albums:[{...album('one'),artistId:'artist-one'},album('two')],nextCursor:null});
    await fixture.whenStable();fixture.detectChanges();
    const router=TestBed.inject(Router),navigate=vi.spyOn(router,'navigateByUrl').mockResolvedValue(true);
    const cards=fixture.nativeElement.querySelectorAll('.album-card');
    expect(cards[0].querySelector('a a')).toBeNull();expect(cards[1].querySelector('small a')).toBeNull();
    for(const [selector,path] of [['small a','/artists/artist-one'],['strong a','/albums/one'],['.cover','/albums/one']]){
      navigate.mockClear();const link=cards[0].querySelector(selector) as HTMLAnchorElement;
      expect(link.getAttribute('href')).toBe(path);link.click();
      expect(navigate).toHaveBeenCalledOnce();expect(router.serializeUrl(navigate.mock.calls[0][0] as never)).toBe(path);
    }
  });
});

function album(id: string): Album {
  return {
    id, name: `Album ${id}`, artist: 'Artist', artistId: null, coverUrl: null,
    songCount: 10, durationMs: 1_800_000, year: 2026, genre: 'Rock', genres: ['Rock'],
    favorite: false, playCount: null, lastPlayedAt: null,
  };
}
