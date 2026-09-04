import { DecimalPipe } from '@angular/common';
import { Component, computed, inject, input, output } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { Track } from '@hirmos/contracts';
import { PlaybackSyncService } from '../core/playback-sync.service';
import { AppIconComponent } from './app-icon.component';

@Component({
  selector: 'li[appTrackRow]',
  imports: [RouterLink, DecimalPipe, AppIconComponent],
  host: {
    class: 'track-row',
    '[class.track-row--current]': 'isCurrent()',
    '[class.track-row--playing]': 'isPlaying()',
    '[attr.aria-current]': "isCurrent() ? 'true' : null",
  },
  template: `
    <button class="track-row__play" type="button" (click)="activate()" [attr.aria-label]="actionLabel()">
      @if (showCover()) {
        <span class="track-cover-control">
          @if (track().coverUrl) { <img class="mini-cover" [src]="track().coverUrl" alt=""> }
          @else { <span class="mini-cover">♫</span> }
          <app-icon [name]="isPlaying() ? 'pause' : 'play'" />
        </span>
      } @else {
        <span class="track-leading"><span>{{ position() }}</span><app-icon [name]="isPlaying() ? 'pause' : 'play'" /></span>
      }
    </button>
    <div class="track-row__copy">
      <button class="track-row__title" type="button" (click)="activate()" [attr.aria-label]="actionLabel()">{{ track().title }}</button>
      <div class="track-row__meta">
        @if (track().artistId) { <a [routerLink]="['/artists', track().artistId]">{{ track().artist }}</a> }
        @else { <span>{{ track().artist }}</span> }
        @if (track().album) {
          <span aria-hidden="true">·</span>
          @if (track().albumId) { <a [routerLink]="['/albums', track().albumId]">{{ track().album }}</a> }
          @else { <span>{{ track().album }}</span> }
        }
      </div>
    </div>
    @if (trailingText()) { <time>{{ trailingText() }}</time> }
    @else if (showDuration()) { <time>{{ track().durationMs / 60000 | number:'1.0-0' }} min</time> }
  `,
})
export class TrackRowComponent {
  private readonly playback = inject(PlaybackSyncService);
  public readonly track = input.required<Track>();
  public readonly position = input<number | null>(null);
  public readonly showCover = input(false);
  public readonly showDuration = input(true);
  public readonly trailingText = input<string | null>(null);
  public readonly playTrack = output<Track>();

  protected readonly isCurrent = computed(() =>
    this.playback.snapshot()?.currentTrackRef === this.track().id,
  );
  protected readonly isPlaying = computed(() =>
    this.isCurrent() && this.playback.snapshot()?.status === 'playing',
  );
  protected readonly actionLabel = computed(() =>
    `${this.isPlaying() ? 'Pausar' : 'Reproducir'} ${this.track().title}`,
  );

  protected activate(): void {
    if (this.isCurrent()) {
      void this.playback.toggle();
      return;
    }
    this.playTrack.emit(this.track());
  }
}
