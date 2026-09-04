import { HttpClient } from '@angular/common/http';
import { Component, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import type { SearchResponse, Track } from '@hirmos/contracts';
import { firstValueFrom } from 'rxjs';
import { PlaybackSyncService } from '../../core/playback-sync.service';
import { TrackRowComponent } from '../../shared/track-row.component';

@Component({ selector: 'app-search', imports: [RouterLink, TrackRowComponent], templateUrl: './search.component.html' })
export class SearchComponent {
  private readonly http = inject(HttpClient);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);
  protected readonly playback = inject(PlaybackSyncService);
  protected readonly query = signal('');
  protected readonly result = signal<SearchResponse | null>(null);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);

  public constructor() {
    this.route.queryParamMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((params) => {
      const query = params.get('q')?.trim() ?? '';
      this.query.set(query);
      if (query) void this.search(query); else this.result.set(null);
    });
  }

  protected play(track: Track): void { void this.playback.select(track); }

  private async search(query: string): Promise<void> {
    this.loading.set(true); this.error.set(null);
    try { this.result.set(await firstValueFrom(this.http.get<SearchResponse>('/api/music/search', { params: { q: query } }))); }
    catch { this.error.set('No pudimos completar la búsqueda.'); }
    finally { this.loading.set(false); }
  }
}
