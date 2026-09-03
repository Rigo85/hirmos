import { HttpClient } from '@angular/common/http';
import { DecimalPipe } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { LibraryHomeResponse, Track } from '@hirmos/contracts';
import { firstValueFrom } from 'rxjs';
import { AudioPlayerService } from '../../core/audio-player.service';
import { PlaybackSyncService } from '../../core/playback-sync.service';
import { SessionStore } from '../../core/session.store';
import { AppIconComponent } from '../../shared/app-icon.component';

@Component({ selector: 'app-home', imports: [RouterLink, DecimalPipe, AppIconComponent], templateUrl: './home.component.html' })
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
}
