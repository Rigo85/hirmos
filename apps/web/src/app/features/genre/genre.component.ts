import { HttpClient } from '@angular/common/http';
import { Component, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import type { GenreDetailResponse, Track } from '@hirmos/contracts';
import { firstValueFrom } from 'rxjs';
import { PlaybackSyncService } from '../../core/playback-sync.service';
import { AppIconComponent } from '../../shared/app-icon.component';
import { TrackRowComponent } from '../../shared/track-row.component';

@Component({
  selector: 'app-genre',
  imports: [RouterLink, AppIconComponent, TrackRowComponent],
  templateUrl: './genre.component.html',
})
export class GenreComponent {
  private readonly http = inject(HttpClient);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);
  protected readonly playback = inject(PlaybackSyncService);
  protected readonly detail = signal<GenreDetailResponse | null>(null);
  protected readonly error = signal<string | null>(null);

  public constructor() {
    this.route.paramMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((params) => {
      const name = params.get('name');
      if (name) void this.load(name);
    });
  }

  protected play(track: Track): void {
    const detail = this.detail();
    if (!detail) return;
    void this.playback.selectContext(
      detail.tracks, detail.tracks.findIndex((item) => item.id === track.id),
      'genre', detail.genre,
    );
  }

  protected shuffle(): void {
    const detail = this.detail();
    if (!detail?.tracks.length) return;
    const tracks = [...detail.tracks];
    for (let index = tracks.length - 1; index > 0; index--) {
      const replacement = Math.floor(Math.random() * (index + 1));
      [tracks[index], tracks[replacement]] = [tracks[replacement]!, tracks[index]!];
    }
    void this.playback.selectContext(tracks, 0, 'genre', detail.genre);
  }

  private async load(name: string): Promise<void> {
    this.detail.set(null); this.error.set(null);
    try {
      this.detail.set(await firstValueFrom(this.http.get<GenreDetailResponse>(
        `/api/library/genres/${encodeURIComponent(name)}`, { params: { limit: 100 } },
      )));
    } catch { this.error.set('No pudimos abrir este género.'); }
  }
}
