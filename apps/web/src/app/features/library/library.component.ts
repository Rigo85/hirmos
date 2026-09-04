import { HttpClient } from '@angular/common/http';
import { Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
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
  protected readonly playback = inject(PlaybackSyncService);
  protected readonly view = signal<LibraryView>('albums');
  protected readonly albums = signal<Album[]>([]);
  protected readonly artists = signal<Artist[]>([]);
  protected readonly tracks = signal<Track[]>([]);
  protected readonly genres = signal<Genre[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);

  public constructor() { void this.load(); }

  protected select(view: LibraryView): void { this.view.set(view); }
  protected play(track: Track): void { void this.playback.select(track); }

  private async load(): Promise<void> {
    try {
      const [albums, artists, tracks, genres] = await Promise.all([
        firstValueFrom(this.http.get<AlbumListResponse>('/api/library/albums', { params: { limit: 60, sort: 'alphabeticalByName' } })),
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
