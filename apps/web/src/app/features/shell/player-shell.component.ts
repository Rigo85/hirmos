import { HttpClient } from '@angular/common/http';
import { Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import type { LyricsResponse } from '@hirmos/contracts';
import { firstValueFrom } from 'rxjs';
import { AudioPlayerService } from '../../core/audio-player.service';
import { PlaybackSyncService } from '../../core/playback-sync.service';
import { SessionStore } from '../../core/session.store';
import { AppIconComponent } from '../../shared/app-icon.component';

@Component({
  selector: 'app-player-shell',
  imports: [RouterLink, RouterLinkActive, RouterOutlet, AppIconComponent],
  templateUrl: './player-shell.component.html',
})
export class PlayerShellComponent {
  private readonly sidebarPreferenceKey = 'hirmos.sidebar.collapsed';
  private readonly router = inject(Router);
  private readonly http = inject(HttpClient);
  protected readonly sessionStore = inject(SessionStore);
  protected readonly player = inject(AudioPlayerService);
  protected readonly playback = inject(PlaybackSyncService);
  protected readonly sidebarCollapsed = signal(readSidebarPreference(this.sidebarPreferenceKey));
  protected readonly mobileMenuOpen = signal(false);
  protected readonly queueOpen = signal(false);
  protected readonly lyricsOpen = signal(false);
  protected readonly lyrics = signal<LyricsResponse['lyrics'][number] | null>(null);
  protected readonly lyricsError = signal<string | null>(null);
  protected readonly currentTrack = computed(() => {
    const snapshot = this.playback.snapshot();
    return snapshot?.currentTrackRef
      ? this.playback.trackFor(snapshot.currentTrackRef)
      : this.player.track();
  });

  public constructor() { this.playback.connect(); }

  protected toggleSidebar(): void {
    this.sidebarCollapsed.update((collapsed) => {
      const next = !collapsed;
      try { localStorage.setItem(this.sidebarPreferenceKey, String(next)); } catch { /* preference is optional */ }
      return next;
    });
  }

  protected search(event: Event, input: HTMLInputElement): void {
    event.preventDefault();
    const q = input.value.trim();
    if (q) void this.router.navigate(['/search'], { queryParams: { q } });
  }

  protected async logout(): Promise<void> {
    this.playback.disconnect();
    await this.sessionStore.logout();
    await this.router.navigate(['/login']);
  }

  protected async toggleLyrics(): Promise<void> {
    const track = this.currentTrack();
    if (!track) return;
    this.queueOpen.set(false);
    this.lyricsOpen.set(!this.lyricsOpen());
    if (!this.lyricsOpen()) return;
    this.lyrics.set(null);
    this.lyricsError.set(null);
    try {
      const response = await firstValueFrom(this.http.get<LyricsResponse>(
        `/api/music/tracks/${encodeURIComponent(track.id)}/lyrics`,
      ));
      this.lyrics.set(response.lyrics[0] ?? null);
      if (!response.lyrics.length) this.lyricsError.set('Esta canción no tiene letra disponible.');
    } catch { this.lyricsError.set('No pudimos cargar la letra.'); }
  }

  protected openQueue(): void {
    this.lyricsOpen.set(false);
    this.queueOpen.set(true);
  }

  protected seekTo(event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    if (Number.isFinite(value)) void this.playback.seek(value);
  }

  protected changeVolume(event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    if (Number.isFinite(value)) this.player.setVolume(value);
  }

  protected formatTime(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
    return `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`;
  }
}

function readSidebarPreference(key: string): boolean {
  try { return localStorage.getItem(key) === 'true'; } catch { return false; }
}
