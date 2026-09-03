import { HttpClient } from '@angular/common/http';
import { DecimalPipe } from '@angular/common';
import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import type { ArtistDetail, Track } from '@hirmos/contracts';
import { firstValueFrom } from 'rxjs';
import { PlaybackSyncService } from '../../core/playback-sync.service';
import { AppIconComponent } from '../../shared/app-icon.component';

@Component({ selector: 'app-artist', imports: [RouterLink, DecimalPipe, AppIconComponent], templateUrl: './artist.component.html' })
export class ArtistComponent {
  private readonly http = inject(HttpClient);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);
  protected readonly playback = inject(PlaybackSyncService);
  protected readonly artist = signal<ArtistDetail | null>(null);
  protected readonly songCount = computed(() =>
    this.artist()?.albums.reduce((total, album) => total + album.songCount, 0) ?? 0,
  );
  protected readonly error = signal<string | null>(null);
  public constructor() {
    this.route.paramMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((params) => {
      const id = params.get('id'); if (id) void this.load(id);
    });
  }
  protected play(track: Track): void {
    const artist = this.artist();
    if (!artist) return;
    void this.playback.selectContext(
      artist.topTracks,
      artist.topTracks.findIndex((item) => item.id === track.id),
      'artist',
      artist.id,
    );
  }
  private async load(id: string): Promise<void> {
    this.artist.set(null); this.error.set(null);
    try { this.artist.set(await firstValueFrom(this.http.get<ArtistDetail>(`/api/library/artists/${encodeURIComponent(id)}`))); }
    catch { this.error.set('No pudimos abrir este artista.'); }
  }
}
