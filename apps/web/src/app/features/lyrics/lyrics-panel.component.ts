import { HttpClient } from '@angular/common/http';
import {
  Component,
  ElementRef,
  OnDestroy,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import type { LyricsResponse, Track } from '@hirmos/contracts';
import type { Subscription } from 'rxjs';
import { PlaybackSyncService } from '../../core/playback-sync.service';
import { AppIconComponent } from '../../shared/app-icon.component';

type LyricsDocument = LyricsResponse['lyrics'][number];
type LyricLine = LyricsDocument['lines'][number];

@Component({
  selector: 'app-lyrics-panel',
  imports: [AppIconComponent],
  templateUrl: './lyrics-panel.component.html',
  styleUrl: './lyrics-panel.component.scss',
})
export class LyricsPanelComponent implements OnDestroy {
  private readonly http = inject(HttpClient);
  private readonly playback = inject(PlaybackSyncService);
  private readonly scrollContainer = viewChild<ElementRef<HTMLElement>>('scrollContainer');
  private scrollTimer: ReturnType<typeof setTimeout> | null = null;
  private adjustmentSave: Subscription | null = null;

  public readonly open = input(false);
  public readonly track = input<Track | null>(null);
  public readonly closed = output<void>();

  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly lyricsDocument = signal<LyricsDocument | null>(null);
  protected readonly adjustmentMs = signal(0);
  protected readonly adjustmentError = signal<string | null>(null);
  protected readonly playbackPositionMs = signal(0);
  protected readonly activeLineIndex = signal(-1);
  protected readonly following = signal(true);
  protected readonly synchronized = computed(() => {
    const lyrics = this.lyricsDocument();
    return Boolean(lyrics?.synced && lyrics.lines.some((line) => line.startMs !== null));
  });

  public constructor() {
    effect((onCleanup) => {
      const track = this.track();
      if (!this.open() || !track) {
        this.loading.set(false);
        this.error.set(null);
        this.lyricsDocument.set(null);
        this.activeLineIndex.set(-1);
        return;
      }

      this.loading.set(true);
      this.error.set(null);
      this.adjustmentError.set(null);
      this.adjustmentMs.set(0);
      this.lyricsDocument.set(null);
      this.activeLineIndex.set(-1);
      this.following.set(true);

      const subscription = this.http.get<LyricsResponse>(
        `/api/music/tracks/${encodeURIComponent(track.id)}/lyrics`,
      ).subscribe({
        next: (response) => {
          const selected = response.lyrics.find((lyrics) =>
            lyrics.synced && lyrics.lines.some((line) => line.startMs !== null),
          ) ?? response.lyrics[0] ?? null;
          this.lyricsDocument.set(selected);
          this.adjustmentMs.set(response.adjustmentMs);
          this.loading.set(false);
          if (!selected) this.error.set('Esta canción no tiene letra disponible.');
        },
        error: () => {
          this.loading.set(false);
          this.error.set('No pudimos cargar la letra.');
        },
      });
      onCleanup(() => subscription.unsubscribe());
    });

    effect((onCleanup) => {
      if (!this.open() || !this.synchronized()) {
        this.activeLineIndex.set(-1);
        return;
      }

      const update = () => {
        const track = this.track();
        const lyrics = this.lyricsDocument();
        if (!track || !lyrics) return;
        const playbackMs = Math.min(
          track.durationMs,
          Math.max(0, this.playback.currentPositionSeconds() * 1_000),
        );
        this.playbackPositionMs.set(playbackMs);
        const nextIndex = findActiveLyricLine(
          lyrics.lines,
          playbackMs + this.adjustmentMs(),
        );
        if (nextIndex === this.activeLineIndex()) return;
        this.activeLineIndex.set(nextIndex);
        if (this.following()) this.scheduleActiveLineScroll();
      };

      update();
      const interval = setInterval(update, 100);
      onCleanup(() => clearInterval(interval));
    });
  }

  public ngOnDestroy(): void {
    if (this.scrollTimer) clearTimeout(this.scrollTimer);
    this.adjustmentSave?.unsubscribe();
  }

  protected close(): void {
    this.closed.emit();
  }

  protected seekToLine(line: LyricLine): void {
    if (line.startMs === null) return;
    this.following.set(true);
    const targetMs = Math.max(0, line.startMs - this.adjustmentMs());
    void this.playback.seek(targetMs / 1_000);
    this.scheduleActiveLineScroll();
  }

  protected pauseFollowing(): void {
    if (this.synchronized()) this.following.set(false);
  }

  protected handleScrollKey(event: KeyboardEvent): void {
    if (['ArrowDown', 'ArrowUp', 'End', 'Home', 'PageDown', 'PageUp', ' '].includes(event.key)) {
      this.pauseFollowing();
    }
  }

  protected resumeFollowing(): void {
    this.following.set(true);
    this.scheduleActiveLineScroll();
  }

  protected adjustTiming(deltaMs: number): void {
    const track = this.track();
    if (!track) return;
    const adjustmentMs = Math.max(-30_000, Math.min(30_000, this.adjustmentMs() + deltaMs));
    this.adjustmentMs.set(adjustmentMs);
    this.adjustmentError.set(null);
    this.adjustmentSave?.unsubscribe();
    this.adjustmentSave = this.http.put<{ adjustmentMs: number }>(
      `/api/music/tracks/${encodeURIComponent(track.id)}/lyrics-adjustment`,
      { adjustmentMs },
    ).subscribe({
      next: (response) => {
        if (this.track()?.id === track.id) this.adjustmentMs.set(response.adjustmentMs);
      },
      error: () => {
        if (this.track()?.id === track.id) {
          this.adjustmentError.set('No pudimos guardar el ajuste de sincronía.');
        }
      },
    });
  }

  protected resetTiming(): void {
    this.adjustTiming(-this.adjustmentMs());
  }

  protected formatAdjustment(): string {
    const value = this.adjustmentMs();
    if (value === 0) return 'Sin ajuste';
    const seconds = Math.abs(value / 1_000).toFixed(1);
    return `${value > 0 ? '+' : '−'}${seconds} s`;
  }

  protected wordProgress(word: NonNullable<LyricLine['words']>[number]): number {
    const positionMs = this.playbackPositionMs() + this.adjustmentMs();
    if (positionMs <= word.startMs) return 0;
    if (word.endMs === null || word.endMs <= word.startMs) return 100;
    return Math.min(100, Math.max(0,
      ((positionMs - word.startMs) / (word.endMs - word.startMs)) * 100,
    ));
  }

  private scheduleActiveLineScroll(): void {
    if (this.scrollTimer) clearTimeout(this.scrollTimer);
    this.scrollTimer = setTimeout(() => {
      this.scrollTimer = null;
      if (!this.following()) return;
      const container = this.scrollContainer()?.nativeElement;
      const index = this.activeLineIndex();
      const line = container?.querySelector<HTMLElement>(`[data-lyric-index="${index}"]`);
      if (!container || !line) return;
      const top = line.offsetTop - container.clientHeight / 2 + line.offsetHeight / 2;
      const behavior = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
        ? 'auto'
        : 'smooth';
      if (typeof container.scrollTo === 'function') {
        container.scrollTo({ top: Math.max(0, top), behavior });
      } else {
        container.scrollTop = Math.max(0, top);
      }
    }, 0);
  }
}

export function findActiveLyricLine(lines: LyricLine[], positionMs: number): number {
  const timed = lines.flatMap((line, index) =>
    line.startMs === null ? [] : [{ index, startMs: line.startMs }],
  ).sort((left, right) => left.startMs - right.startMs || left.index - right.index);
  let low = 0;
  let high = timed.length - 1;
  let match = -1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (timed[middle].startMs <= positionMs) {
      match = timed[middle].index;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return match;
}
