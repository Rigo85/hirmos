import { HttpClient } from '@angular/common/http';
import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';
import type { Track, TrackListResponse } from '@hirmos/contracts';
import { firstValueFrom } from 'rxjs';
import { PlaybackSyncService } from '../../core/playback-sync.service';
import { TrackRowComponent } from '../../shared/track-row.component';

type ActivityKind = 'recent' | 'most-played';

@Component({
  selector: 'app-activity',
  imports: [TrackRowComponent],
  templateUrl: './activity.component.html',
})
export class ActivityComponent {
  private readonly http = inject(HttpClient);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);
  protected readonly playback = inject(PlaybackSyncService);
  protected readonly kind = signal<ActivityKind>('recent');
  protected readonly tracks = signal<Track[]>([]);
  protected readonly nextCursor = signal<string | null>(null);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly copy = computed(() => this.kind() === 'recent'
    ? {
        eyebrow: 'TU ACTIVIDAD',
        title: 'Escuchado recientemente',
        description: 'Tu recorrido más reciente, desde lo último que escuchaste.',
      }
    : {
        eyebrow: 'TUS HÁBITOS',
        title: 'Lo que más escuchas',
        description: 'Ordenado por tiempo escuchado, finales y reproducciones.',
      });

  public constructor() {
    this.route.paramMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((params) => {
      this.kind.set(params.get('kind') === 'most-played' ? 'most-played' : 'recent');
      this.tracks.set([]);
      this.nextCursor.set(null);
      void this.load();
    });
  }

  protected async loadMore(): Promise<void> {
    if (!this.nextCursor() || this.loading()) return;
    await this.load(this.nextCursor()!);
  }

  protected play(track: Track): void {
    const tracks = this.tracks();
    void this.playback.selectContext(
      tracks,
      tracks.findIndex((item) => item.id === track.id),
      'home',
      `activity:${this.kind()}`,
    );
  }

  private async load(cursor?: string): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const response = await firstValueFrom(this.http.get<TrackListResponse>(
        `/api/library/activity/${this.kind()}`,
        { params: { limit: 30, ...(cursor ? { cursor } : {}) } },
      ));
      this.tracks.update((current) => cursor ? [...current, ...response.tracks] : response.tracks);
      this.nextCursor.set(response.nextCursor);
    } catch {
      this.error.set('No pudimos cargar esta actividad.');
    } finally {
      this.loading.set(false);
    }
  }
}
