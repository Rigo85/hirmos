import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { HabitArtist, HabitsResponse } from '@hirmos/contracts';
import { PlaybackSyncService } from '../../core/playback-sync.service';
import { HabitsComponent } from './habits.component';

describe('HabitsComponent', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [HabitsComponent],
      providers: [
        provideHttpClient(), provideHttpClientTesting(), provideRouter([]),
        {
          provide: PlaybackSyncService,
          useValue: {
            selectContext: vi.fn(), snapshot: signal({ currentTrackRef: null, status: 'paused' }),
            toggle: vi.fn(),
          },
        },
      ],
    }).compileComponents();
  });

  it('starts with artist habits for 30 days and switches period explicitly', async () => {
    const fixture = TestBed.createComponent(HabitsComponent);
    fixture.detectChanges();
    const http = TestBed.inject(HttpTestingController);
    http.expectOne((request) => request.url === '/api/library/habits'
      && request.params.get('kind') === 'artists'
      && request.params.get('period') === '30d')
      .flush(response([artist()]));
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.habit-detail-card strong').textContent).toContain('Queensrÿche');
    const root = fixture.nativeElement as HTMLElement;
    const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>('.period-switch button'));
    buttons.find((button) => button.textContent?.includes('Todo'))!.click();
    http.expectOne((request) => request.params.get('period') === 'all').flush(response([artist()], 'all'));
    await fixture.whenStable();
    fixture.detectChanges();
    expect(buttons.find((button) => button.textContent?.includes('Todo'))!.classList).toContain('active');
  });
});

function response(artists: HabitArtist[], period: '30d' | 'all' = '30d'): HabitsResponse {
  return {
    kind: 'artists', period, dataSince: '2026-09-03T00:00:00.000Z', artists,
    albums: [], tracks: [], nextCursor: null,
  };
}

function artist(): HabitArtist {
  return {
    id: 'artist-id', name: 'Queensrÿche', coverUrl: null, albumCount: 0, favorite: false,
    listenedMs: 765_000, playStarts: 8, qualifiedPlays: 1, importedPlays: 0,
    completions: 1, skips: 0,
    trackCount: 3, lastPlayedAt: '2026-09-04T00:00:00.000Z', estimated: true,
  };
}
