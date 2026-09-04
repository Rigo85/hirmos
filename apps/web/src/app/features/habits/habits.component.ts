import { HttpClient } from '@angular/common/http';
import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import type {
  HabitAlbum, HabitArtist, HabitKind, HabitPeriod, HabitsResponse, HabitTrack, Track,
} from '@hirmos/contracts';
import { firstValueFrom } from 'rxjs';
import { PlaybackSyncService } from '../../core/playback-sync.service';
import { TrackRowComponent } from '../../shared/track-row.component';

@Component({
  selector: 'app-habits',
  imports: [RouterLink, TrackRowComponent],
  templateUrl: './habits.component.html',
})
export class HabitsComponent {
  private readonly http = inject(HttpClient);
  protected readonly playback = inject(PlaybackSyncService);
  protected readonly kind = signal<HabitKind>('artists');
  protected readonly period = signal<HabitPeriod>('30d');
  protected readonly artists = signal<HabitArtist[]>([]);
  protected readonly albums = signal<HabitAlbum[]>([]);
  protected readonly tracks = signal<HabitTrack[]>([]);
  protected readonly dataSince = signal<string | null>(null);
  protected readonly nextCursor = signal<string | null>(null);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly hasResults = computed(() => this.kind() === 'artists'
    ? this.artists().length > 0
    : this.kind() === 'albums' ? this.albums().length > 0 : this.tracks().length > 0);
  protected readonly hasEstimatedData = computed(() => {
    const values = this.kind() === 'artists'
      ? this.artists()
      : this.kind() === 'albums' ? this.albums() : this.tracks();
    return values.some((item) => item.estimated);
  });
  protected readonly hasImportedData = computed(() => {
    const values = this.kind() === 'artists'
      ? this.artists()
      : this.kind() === 'albums' ? this.albums() : this.tracks();
    return values.some((item) => item.importedPlays > 0);
  });

  public constructor() { void this.load(); }

  protected selectKind(kind: HabitKind): void {
    if (kind === this.kind()) return;
    this.kind.set(kind);
    void this.resetAndLoad();
  }

  protected selectPeriod(period: HabitPeriod): void {
    if (period === this.period()) return;
    this.period.set(period);
    void this.resetAndLoad();
  }

  protected async loadMore(): Promise<void> {
    const cursor = this.nextCursor();
    if (!cursor || this.loading()) return;
    await this.load(cursor);
  }

  protected play(track: Track): void {
    const tracks = this.tracks();
    void this.playback.selectContext(
      tracks,
      tracks.findIndex((item) => item.id === track.id),
      'home',
      `habits:${this.period()}`,
    );
  }

  protected metric(item: HabitArtist | HabitAlbum | HabitTrack): string {
    const parts: string[] = [];
    if (item.listenedMs > 0) parts.push(this.listeningTime(item.listenedMs));
    if (item.qualifiedPlays > 0) {
      parts.push(`${item.qualifiedPlays} ${item.qualifiedPlays === 1 ? 'escucha' : 'escuchas'}`);
    }
    return parts.join(' · ') || `${item.playStarts} ${item.playStarts === 1 ? 'inicio' : 'inicios'}`;
  }

  protected listeningTime(milliseconds: number): string {
    const minutes = Math.max(1, Math.round(milliseconds / 60_000));
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.floor(minutes / 60);
    const remainder = minutes % 60;
    return remainder ? `${hours} h ${remainder} min` : `${hours} h`;
  }

  protected sinceLabel(): string | null {
    const value = this.dataSince();
    if (!value) return null;
    return new Intl.DateTimeFormat('es', { day: 'numeric', month: 'long', year: 'numeric' })
      .format(new Date(value));
  }

  private async resetAndLoad(): Promise<void> {
    this.artists.set([]);
    this.albums.set([]);
    this.tracks.set([]);
    this.nextCursor.set(null);
    await this.load();
  }

  private async load(cursor?: string): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const response = await firstValueFrom(this.http.get<HabitsResponse>('/api/library/habits', {
        params: {
          kind: this.kind(), period: this.period(), limit: 30,
          ...(cursor ? { cursor } : {}),
        },
      }));
      this.artists.update((current) => cursor ? [...current, ...response.artists] : response.artists);
      this.albums.update((current) => cursor ? [...current, ...response.albums] : response.albums);
      this.tracks.update((current) => cursor ? [...current, ...response.tracks] : response.tracks);
      this.dataSince.set(response.dataSince);
      this.nextCursor.set(response.nextCursor);
    } catch {
      this.error.set('No pudimos calcular tus hábitos.');
    } finally {
      this.loading.set(false);
    }
  }
}
