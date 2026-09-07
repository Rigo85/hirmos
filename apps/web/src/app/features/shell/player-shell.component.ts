import { DOCUMENT } from '@angular/common';
import { Component, computed, DestroyRef, effect, HostListener, inject, signal } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { AudioPlayerService } from '../../core/audio-player.service';
import { PlaybackSyncService } from '../../core/playback-sync.service';
import { SessionStore } from '../../core/session.store';
import { AppIconComponent } from '../../shared/app-icon.component';
import { LyricsPanelComponent } from '../lyrics/lyrics-panel.component';
import { FavoritesService } from '../../core/favorites.service';

@Component({
  selector: 'app-player-shell',
  imports: [RouterLink, RouterLinkActive, RouterOutlet, AppIconComponent, LyricsPanelComponent],
  templateUrl: './player-shell.component.html',
})
export class PlayerShellComponent {
  private readonly sidebarPreferenceKey = 'hirmos.sidebar.collapsed';
  private readonly mobilePlayerHistoryKey = 'hirmosNowPlaying';
  private readonly document = inject(DOCUMENT);
  private readonly destroyRef = inject(DestroyRef);
  private readonly router = inject(Router);
  protected readonly sessionStore = inject(SessionStore);
  protected readonly player = inject(AudioPlayerService);
  protected readonly playback = inject(PlaybackSyncService);
  protected readonly favorites = inject(FavoritesService);
  protected readonly sidebarCollapsed = signal(readSidebarPreference(this.sidebarPreferenceKey));
  protected readonly mobileMenuOpen = signal(false);
  protected readonly mobilePlayerOpen = signal(false);
  protected readonly mobileSeekPreviewSeconds = signal<number | null>(null);
  private readonly positionClock = signal(Date.now());
  protected readonly queueOpen = signal(false);
  protected readonly lyricsOpen = signal(false);
  private mobilePlayerHistoryEntry = false;
  private mobilePlayerSwipeStart: { x: number; y: number } | null = null;
  protected readonly currentTrack = computed(() => {
    const snapshot = this.playback.snapshot();
    return snapshot?.currentTrackRef
      ? this.playback.trackFor(snapshot.currentTrackRef)
      : this.player.track();
  });
  protected readonly displayedPositionSeconds = computed(() => {
    const preview = this.mobileSeekPreviewSeconds();
    if (preview !== null) return preview;
    return this.playback.ownsLease()
      ? this.player.positionSeconds()
      : this.playback.currentPositionSeconds(this.positionClock());
  });
  protected readonly mobileProgressPercent = computed(() => {
    const duration = (this.currentTrack()?.durationMs ?? 0) / 1_000;
    if (!duration) return 0;
    return Math.min(100, Math.max(0, this.displayedPositionSeconds() / duration * 100));
  });

  public constructor() {
    this.playback.connect();
    const positionTimer = setInterval(() => this.positionClock.set(Date.now()), 1_000);
    this.destroyRef.onDestroy(() => clearInterval(positionTimer));
    effect((onCleanup) => {
      if (!this.mobileMenuOpen() && !this.mobilePlayerOpen()) return;
      const previousOverflow = this.document.body.style.overflow;
      this.document.body.style.overflow = 'hidden';
      onCleanup(() => { this.document.body.style.overflow = previousOverflow; });
    });
  }

  protected closeMobileMenu(): void {
    this.mobileMenuOpen.set(false);
  }

  protected openMobilePlayer(): void {
    if (!this.currentTrack() || this.mobilePlayerOpen()) return;
    this.closeMobileMenu();
    this.queueOpen.set(false);
    this.lyricsOpen.set(false);
    this.mobilePlayerOpen.set(true);
    const view = this.document.defaultView;
    if (view) {
      view.history.pushState({ ...view.history.state, [this.mobilePlayerHistoryKey]: true }, '');
      this.mobilePlayerHistoryEntry = true;
    }
    queueMicrotask(() => {
      this.document.querySelector<HTMLElement>('.mobile-now-playing__close')?.focus();
    });
  }

  protected closeMobilePlayer(): void {
    if (!this.mobilePlayerOpen()) return;
    const view = this.document.defaultView;
    const shouldPopHistory = this.mobilePlayerHistoryEntry
      && Boolean(view?.history.state?.[this.mobilePlayerHistoryKey]);
    this.finishClosingMobilePlayer();
    if (shouldPopHistory) view?.history.back();
  }

  @HostListener('window:popstate')
  protected handleBrowserBack(): void {
    if (this.mobilePlayerOpen()) this.finishClosingMobilePlayer();
  }

  @HostListener('document:keydown.escape')
  protected handleEscape(): void {
    if (this.lyricsOpen()) this.lyricsOpen.set(false);
    else if (this.queueOpen()) this.queueOpen.set(false);
    else if (this.mobilePlayerOpen()) this.closeMobilePlayer();
    else this.closeMobileMenu();
  }

  protected previewMobileSeek(event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    if (Number.isFinite(value)) this.mobileSeekPreviewSeconds.set(value);
  }

  protected async commitMobileSeek(event: Event): Promise<void> {
    const value = Number((event.target as HTMLInputElement).value);
    if (Number.isFinite(value)) await this.playback.seek(value);
    this.mobileSeekPreviewSeconds.set(null);
  }

  protected startMobilePlayerSwipe(event: PointerEvent): void {
    this.mobilePlayerSwipeStart = { x: event.clientX, y: event.clientY };
  }

  protected finishMobilePlayerSwipe(event: PointerEvent): void {
    const start = this.mobilePlayerSwipeStart;
    this.mobilePlayerSwipeStart = null;
    if (!start) return;
    const vertical = event.clientY - start.y;
    const horizontal = Math.abs(event.clientX - start.x);
    if (vertical >= 72 && vertical > horizontal * 1.25) this.closeMobilePlayer();
  }

  protected trapMobilePlayerFocus(event: Event, dialog: HTMLElement): void {
    const keyboardEvent = event as KeyboardEvent;
    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )).filter((element) => !element.hasAttribute('hidden'));
    if (focusable.length < 2) return;
    const first = focusable[0]!;
    const last = focusable.at(-1)!;
    if (keyboardEvent.shiftKey && this.document.activeElement === first) {
      keyboardEvent.preventDefault();
      last.focus();
    } else if (!keyboardEvent.shiftKey && this.document.activeElement === last) {
      keyboardEvent.preventDefault();
      first.focus();
    }
  }

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

  protected toggleLyrics(): void {
    if (!this.currentTrack()) return;
    this.queueOpen.set(false);
    this.lyricsOpen.set(!this.lyricsOpen());
  }

  protected toggleQueue(): void {
    this.lyricsOpen.set(false);
    this.queueOpen.update((open) => !open);
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

  private finishClosingMobilePlayer(): void {
    this.mobilePlayerOpen.set(false);
    this.mobilePlayerHistoryEntry = false;
    this.mobileSeekPreviewSeconds.set(null);
    this.queueOpen.set(false);
    this.lyricsOpen.set(false);
    queueMicrotask(() => {
      this.document.querySelector<HTMLElement>('.mobile-player-open')?.focus();
    });
  }
}

function readSidebarPreference(key: string): boolean {
  try { return localStorage.getItem(key) === 'true'; } catch { return false; }
}
