import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import type { Track } from '@hirmos/contracts';
import { of } from 'rxjs';
import { PlaybackSyncService } from '../../core/playback-sync.service';
import { ActivityComponent } from './activity.component';

describe('ActivityComponent', () => {
  const selectContext = vi.fn();

  beforeEach(async () => {
    selectContext.mockReset();
    await TestBed.configureTestingModule({
      imports: [ActivityComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        {
          provide: ActivatedRoute,
          useValue: { paramMap: of(convertToParamMap({ kind: 'recent' })) },
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

  it('loads the complete recent view by pages and plays the visible context', async () => {
    const fixture = TestBed.createComponent(ActivityComponent);
    fixture.detectChanges();
    const http = TestBed.inject(HttpTestingController);
    http.expectOne((request) => request.url === '/api/library/activity/recent'
      && request.params.get('limit') === '30')
      .flush({ tracks: [track('one'), track('two')], nextCursor: '2' });
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('h1').textContent)
      .toContain('Escuchado recientemente');
    expect(fixture.nativeElement.querySelectorAll('.activity-results .track-row')).toHaveLength(2);

    fixture.nativeElement.querySelector('.track-row__title').click();
    expect(selectContext).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ id: 'one' })]),
      0,
      'home',
      'activity:recent',
    );

    fixture.nativeElement.querySelector('.load-more button').click();
    http.expectOne((request) => request.url === '/api/library/activity/recent'
      && request.params.get('cursor') === '2')
      .flush({ tracks: [track('three')], nextCursor: null });
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelectorAll('.activity-results .track-row')).toHaveLength(3);
    expect(fixture.nativeElement.querySelector('.load-more')).toBeNull();
  });
});

function track(id: string): Track {
  return {
    id,
    title: `Canción ${id}`,
    artist: 'Artista',
    artistId: 'artist-id',
    album: 'Álbum',
    albumId: 'album-id',
    durationMs: 180_000,
    coverUrl: null,
    year: 2026,
    genres: [],
    favorite: false,
  };
}
