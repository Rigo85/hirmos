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
    void this.playback.selectFavorites(false,track.id);
  }

  protected async playAll(): Promise<void> {
    if(this.preparingPlayback())return;this.preparingPlayback.set(true);
    try{await this.playback.selectFavorites();}finally{this.preparingPlayback.set(false);}
  }

  protected async shuffle(): Promise<void> {
    if(this.preparingPlayback())return;this.preparingPlayback.set(true);
    try{await this.playback.selectFavorites(true);}finally{this.preparingPlayback.set(false);}
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

}
