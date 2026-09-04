import { HttpClient } from '@angular/common/http';
import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { HabitArtist, LibraryHomeResponse, Track } from '@hirmos/contracts';
import { firstValueFrom } from 'rxjs';
import { AudioPlayerService } from '../../core/audio-player.service';
import { PlaybackSyncService } from '../../core/playback-sync.service';
import { SessionStore } from '../../core/session.store';
import { AppIconComponent } from '../../shared/app-icon.component';
import { TrackRowComponent } from '../../shared/track-row.component';

@Component({ selector: 'app-home', imports: [RouterLink, AppIconComponent, TrackRowComponent], templateUrl: './home.component.html' })
export class HomeComponent {
  private readonly http = inject(HttpClient);
  protected readonly sessionStore = inject(SessionStore);
  protected readonly playback = inject(PlaybackSyncService);
  protected readonly player = inject(AudioPlayerService);
  protected readonly data = signal<LibraryHomeResponse | null>(null);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly currentTrack = computed(() => {
    const reference = this.playback.snapshot()?.currentTrackRef;
    return reference ? this.playback.trackFor(reference) : this.player.track();
  });

  public constructor() { void this.load(); }

  protected async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try { this.data.set(await firstValueFrom(this.http.get<LibraryHomeResponse>('/api/library/home'))); }
    catch { this.error.set('No pudimos preparar tu inicio.'); }
    finally { this.loading.set(false); }
  }

  protected play(track: Track): void { void this.playback.select(track); }

  protected scrollCarousel(list: HTMLElement, direction: -1 | 1): void {
    list.scrollBy({
      left: direction * Math.max(280, list.clientWidth * 0.8),
      behavior: 'smooth',
    });
  }

  protected listeningTime(milliseconds: number): string {
    const minutes = Math.max(1, Math.round(milliseconds / 60_000));
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.floor(minutes / 60);
    const remainder = minutes % 60;
    return remainder ? `${hours} h ${remainder} min` : `${hours} h`;
  }

  protected habitMetric(artist: HabitArtist): string {
    const listening = artist.listenedMs > 0 ? this.listeningTime(artist.listenedMs) : null;
    const plays = artist.qualifiedPlays > 0
      ? `${artist.qualifiedPlays} ${artist.qualifiedPlays === 1 ? 'escucha' : 'escuchas'}`
      : null;
    return [plays, listening].filter(Boolean).join(' · ') || `${artist.playStarts} inicios`;
  }
}
