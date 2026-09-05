import { HttpClient } from '@angular/common/http';
import { Component, inject, signal } from '@angular/core';
import type { Track, TrackListResponse } from '@hirmos/contracts';
import { firstValueFrom } from 'rxjs';
import { PlaybackSyncService } from '../../core/playback-sync.service';
import { AppIconComponent } from '../../shared/app-icon.component';
import { TrackRowComponent } from '../../shared/track-row.component';

@Component({
  selector: 'app-favorites',
  imports: [AppIconComponent, TrackRowComponent],
  templateUrl: './favorites.component.html',
})
export class FavoritesComponent {
  private readonly http = inject(HttpClient);
  protected readonly playback = inject(PlaybackSyncService);
  protected readonly tracks = signal<Track[]>([]);
  protected readonly nextCursor = signal<string | null>(null);
  protected readonly loading = signal(true);
  protected readonly preparingPlayback = signal(false);
  protected readonly error = signal<string | null>(null);

  public constructor() { void this.load(); }

  protected play(track: Track): void {
    const tracks = this.tracks();
    void this.playback.selectContext(
      tracks, tracks.findIndex((item) => item.id === track.id), 'favorites', 'favorites',
    );
  }

  protected async playAll(): Promise<void> {
    const tracks = await this.completePlaybackContext();
    if (tracks.length) void this.playback.selectContext(
      tracks, 0, 'favorites', 'favorites',
    );
  }

  protected async shuffle(): Promise<void> {
    const tracks = [...await this.completePlaybackContext()];
    if (!tracks.length) return;
    for (let index = tracks.length - 1; index > 0; index--) {
      const replacement = Math.floor(Math.random() * (index + 1));
      [tracks[index], tracks[replacement]] = [tracks[replacement]!, tracks[index]!];
    }
    void this.playback.selectContext(tracks, 0, 'favorites', 'favorites');
  }

  protected removeIfUnfavorited(track: Track, favorite: boolean): void {
    if (!favorite) this.tracks.update((tracks) => tracks.filter((item) => item.id !== track.id));
  }

  protected async loadMore(): Promise<void> {
    const cursor = this.nextCursor();
    if (cursor && !this.loading()) await this.load(cursor);
  }

  private async load(cursor?: string): Promise<void> {
    this.loading.set(true); this.error.set(null);
    try {
      const result = await firstValueFrom(this.http.get<TrackListResponse>(
        '/api/library/favorites',
        { params: { limit: 50, ...(cursor ? { cursor } : {}) } },
      ));
      this.tracks.update((current) => cursor ? [...current, ...result.tracks] : result.tracks);
      this.nextCursor.set(result.nextCursor);
    } catch {
      this.error.set('No pudimos cargar tus favoritos.');
    } finally {
      this.loading.set(false);
    }
  }

  private async completePlaybackContext(): Promise<Track[]> {
    if (!this.nextCursor()) return this.tracks();
    this.preparingPlayback.set(true); this.error.set(null);
    try {
      const result = await firstValueFrom(this.http.get<TrackListResponse>(
        '/api/library/favorites', { params: { limit: 500 } },
      ));
      return result.tracks;
    } catch {
      this.error.set('No pudimos preparar la lista completa para reproducirla.');
      return [];
    } finally {
      this.preparingPlayback.set(false);
    }
  }
}
