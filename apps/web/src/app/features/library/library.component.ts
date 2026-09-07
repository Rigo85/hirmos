import { HttpClient } from '@angular/common/http';
import { Component, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import type {
  Album, AlbumListResponse, Artist, ArtistListResponse, Genre,
  GenreListResponse, LibraryStatsResponse, Track, TrackListResponse,
} from '@hirmos/contracts';
import { firstValueFrom } from 'rxjs';
import { PlaybackSyncService } from '../../core/playback-sync.service';
import { TrackRowComponent } from '../../shared/track-row.component';
import { LazyCoverDirective } from '../../shared/lazy-cover.directive';

type LibraryView = 'albums' | 'artists' | 'tracks' | 'genres';

@Component({ selector: 'app-library', imports: [RouterLink, TrackRowComponent, LazyCoverDirective], templateUrl: './library.component.html' })
export class LibraryComponent {
  private readonly http = inject(HttpClient);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  protected readonly playback = inject(PlaybackSyncService);
  protected readonly view = signal<LibraryView>('albums');
  protected readonly albums = signal<Album[]>([]);
  protected readonly artists = signal<Artist[]>([]);
  protected readonly tracks = signal<Track[]>([]);
  protected readonly genres = signal<Genre[]>([]);
  protected readonly stats = signal<LibraryStatsResponse | null>(null);
  protected readonly nextCursor = signal<string | null>(null);
  protected readonly loading = signal(true);
  protected readonly loadingMore = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly year = signal<number | null>(null);
  private loadVersion = 0;

  public constructor() {
    void this.loadStats();
    this.route.queryParamMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((params) => {
      const requestedView = params.get('view');
      const selected = ['albums', 'artists', 'tracks', 'genres'].includes(requestedView ?? '')
        ? requestedView as LibraryView : 'albums';
      const requestedYear = Number.parseInt(params.get('year') ?? '', 10);
      this.view.set(Number.isInteger(requestedYear) ? 'albums' : selected);
      this.year.set(Number.isInteger(requestedYear) ? requestedYear : null);
      this.nextCursor.set(null);
      this.loadingMore.set(false);
      void this.load(this.year());
    });
  }

  protected select(view: LibraryView): void {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { view: view === 'albums' ? null : view, year: null },
    });
  }
  protected play(track: Track): void { void this.playback.select(track); }

  protected async loadMore(): Promise<void> {
    const cursor = this.nextCursor();
    if (!cursor || this.loading() || this.loadingMore()) return;
    await this.load(this.year(), cursor);
  }

  protected total(view: LibraryView): number | null {
    if (view === 'albums' && this.year()) return null;
    const stats = this.stats();
    return stats?.ready ? stats[view] : null;
  }

  protected loadedCount(): number {
    return this.collection(this.view()).length;
  }

  private async load(year: number | null, cursor?: string): Promise<void> {
    const view = this.view();
    const version = ++this.loadVersion;
    if (cursor) this.loadingMore.set(true); else this.loading.set(true);
    this.error.set(null);
    try {
      switch (view) {
        case 'albums': {
          const result = await firstValueFrom(this.http.get<AlbumListResponse>('/api/library/albums', {
          params: { limit: 60, sort: 'alphabeticalByName', ...(year ? { year } : {}),
            ...(cursor ? { cursor } : {}) },
          }));
          if (version !== this.loadVersion || this.view() !== view) return;
          this.albums.update((current) => cursor ? [...current, ...result.albums] : result.albums);
          this.nextCursor.set(result.nextCursor);
          break;
        }
        case 'artists': {
          const result = await firstValueFrom(this.http.get<ArtistListResponse>(
            '/api/library/artists', { params: { limit: 100, ...(cursor ? { cursor } : {}) } },
          ));
          if (version !== this.loadVersion || this.view() !== view) return;
          this.artists.update((current) => cursor ? [...current, ...result.artists] : result.artists);
          this.nextCursor.set(result.nextCursor);
          break;
        }
        case 'tracks': {
          const result = await firstValueFrom(this.http.get<TrackListResponse>(
            '/api/library/tracks', { params: { limit: 100, ...(cursor ? { cursor } : {}) } },
          ));
          if (version !== this.loadVersion || this.view() !== view) return;
          this.tracks.update((current) => cursor ? [...current, ...result.tracks] : result.tracks);
          this.nextCursor.set(result.nextCursor);
          break;
        }
        case 'genres': {
          const result = await firstValueFrom(this.http.get<GenreListResponse>('/api/library/genres'));
          if (version !== this.loadVersion || this.view() !== view) return;
          this.genres.set(result.genres);
          this.nextCursor.set(null);
          break;
        }
      }
    } catch { this.error.set('No pudimos cargar la biblioteca.'); }
    finally {
      if (version === this.loadVersion) {
        this.loading.set(false);
        this.loadingMore.set(false);
      }
    }
  }

  private async loadStats(): Promise<void> {
    try {
      this.stats.set(await firstValueFrom(
        this.http.get<LibraryStatsResponse>('/api/library/stats'),
      ));
    } catch {
      // The active tab remains usable while a catalog synchronization is pending.
    }
  }

  private collection(view: LibraryView): readonly unknown[] {
    switch (view) {
      case 'albums': return this.albums();
      case 'artists': return this.artists();
      case 'tracks': return this.tracks();
      case 'genres': return this.genres();
    }
  }
}
