import { HttpClient } from '@angular/common/http';
import { Component, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import type {
  Album, AlbumListResponse, Artist, ArtistListResponse, Genre,
  GenreListResponse, Track, TrackListResponse,
} from '@hirmos/contracts';
import { firstValueFrom } from 'rxjs';
import { PlaybackSyncService } from '../../core/playback-sync.service';
import { TrackRowComponent } from '../../shared/track-row.component';

type LibraryView = 'albums' | 'artists' | 'tracks' | 'genres';

@Component({ selector: 'app-library', imports: [RouterLink, TrackRowComponent], templateUrl: './library.component.html' })
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
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly year = signal<number | null>(null);

  public constructor() {
    this.route.queryParamMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((params) => {
      const requestedView = params.get('view');
      const selected = ['albums', 'artists', 'tracks', 'genres'].includes(requestedView ?? '')
        ? requestedView as LibraryView : 'albums';
      const requestedYear = Number.parseInt(params.get('year') ?? '', 10);
      this.view.set(Number.isInteger(requestedYear) ? 'albums' : selected);
      this.year.set(Number.isInteger(requestedYear) ? requestedYear : null);
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

  private async load(year: number | null): Promise<void> {
    this.loading.set(true); this.error.set(null);
    try {
      const [albums, artists, tracks, genres] = await Promise.all([
        firstValueFrom(this.http.get<AlbumListResponse>('/api/library/albums', {
          params: { limit: 60, sort: 'alphabeticalByName', ...(year ? { year } : {}) },
        })),
        firstValueFrom(this.http.get<ArtistListResponse>('/api/library/artists', { params: { limit: 100 } })),
        firstValueFrom(this.http.get<TrackListResponse>('/api/library/tracks', { params: { limit: 100 } })),
        firstValueFrom(this.http.get<GenreListResponse>('/api/library/genres')),
      ]);
      this.albums.set(albums.albums); this.artists.set(artists.artists);
      this.tracks.set(tracks.tracks); this.genres.set(genres.genres);
    } catch { this.error.set('No pudimos cargar la biblioteca.'); }
    finally { this.loading.set(false); }
  }
}
