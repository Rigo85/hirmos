import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { AdminSourceComponent } from './admin-source.component';

describe('AdminSourceComponent', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [AdminSourceComponent],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    }).compileComponents();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts a manual sync and reports the completed catalog counts', async () => {
    const fixture = TestBed.createComponent(AdminSourceComponent);
    fixture.detectChanges();
    const http = TestBed.inject(HttpTestingController);
    http.expectOne('/api/admin/music-source').flush({ source: source() });
    http.expectOne('/api/admin/music-source/sync').flush({
      status: 'idle', startedAt: null, completedAt: null, counts: null,
    });
    await fixture.whenStable();
    fixture.detectChanges();

    vi.useFakeTimers();
    const button = Array.from<HTMLButtonElement>(fixture.nativeElement.querySelectorAll('button'))
      .find((item) => item.textContent?.includes('Sincronizar ahora'))!;
    button.click();
    http.expectOne({ method: 'POST', url: '/api/admin/music-source/sync' }).flush({
      started: true, status: 'running',
      startedAt: '2026-09-08T10:00:00.000Z', completedAt: null, counts: null,
    });
    await vi.advanceTimersByTimeAsync(0);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Sincronizando');

    await vi.advanceTimersByTimeAsync(1_500);
    http.expectOne('/api/admin/music-source/sync').flush({
      status: 'succeeded', startedAt: '2026-09-08T10:00:00.000Z',
      completedAt: '2026-09-08T10:00:05.000Z',
      counts: { artists: 82, albums: 590, tracks: 6888 },
    });
    await vi.advanceTimersByTimeAsync(0);
    http.expectOne('/api/admin/music-source').flush({
      source: { ...source(), lastSyncedAt: '2026-09-08T10:00:05.000Z' },
    });
    await vi.advanceTimersByTimeAsync(0);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent)
      .toContain('Catálogo actualizado: 82 artistas, 590 álbumes y 6888 canciones.');
    fixture.destroy();
  });
});

function source() {
  return {
    id: '33333333-3333-4333-8333-333333333333', name: 'Biblioteca principal',
    baseUrl: 'http://music.example.test', adapterType: 'navidrome',
    enabled: true, healthy: true, capabilities: [], serverVersion: '1',
    lastCheckedAt: null, lastSyncedAt: '2026-09-08T09:00:00.000Z',
  };
}
