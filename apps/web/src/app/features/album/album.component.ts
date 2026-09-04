import { HttpClient } from '@angular/common/http';
import { Component, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import type { AlbumDetail, Track } from '@hirmos/contracts';
import { firstValueFrom } from 'rxjs';
import { PlaybackSyncService } from '../../core/playback-sync.service';
import { AppIconComponent } from '../../shared/app-icon.component';
import { TrackRowComponent } from '../../shared/track-row.component';

@Component({ selector: 'app-album', imports: [RouterLink, AppIconComponent, TrackRowComponent], templateUrl: './album.component.html' })
export class AlbumComponent {
  private readonly http = inject(HttpClient);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);
  protected readonly playback = inject(PlaybackSyncService);
  protected readonly album = signal<AlbumDetail | null>(null);
  protected readonly error = signal<string | null>(null);

  public constructor() {
    this.route.paramMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((params) => {
      const id = params.get('id'); if (id) void this.load(id);
    });
  }
  protected play(track: Track): void {
    const album = this.album();
    if (!album) return;
    void this.playback.selectContext(album.tracks, album.tracks.findIndex((item) => item.id === track.id), 'album', album.id);
  }
  private async load(id: string): Promise<void> {
    this.album.set(null); this.error.set(null);
    try { this.album.set(await firstValueFrom(this.http.get<AlbumDetail>(`/api/library/albums/${encodeURIComponent(id)}`))); }
    catch { this.error.set('No pudimos abrir este álbum.'); }
  }
}
