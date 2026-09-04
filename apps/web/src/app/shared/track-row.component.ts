import { DecimalPipe } from '@angular/common';
import { Component, input, output } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { Track } from '@hirmos/contracts';
import { AppIconComponent } from './app-icon.component';

@Component({
  selector: 'li[appTrackRow]',
  imports: [RouterLink, DecimalPipe, AppIconComponent],
  host: { class: 'track-row' },
  template: `
    <button class="track-row__play" type="button" (click)="playTrack.emit(track())" [attr.aria-label]="'Reproducir ' + track().title">
      @if (showCover()) {
        @if (track().coverUrl) { <img class="mini-cover" [src]="track().coverUrl" alt=""> }
        @else { <span class="mini-cover">♫</span> }
      } @else {
        <span class="track-leading"><span>{{ position() }}</span><app-icon name="play" /></span>
      }
    </button>
    <div class="track-row__copy">
      <button class="track-row__title" type="button" (click)="playTrack.emit(track())" [attr.aria-label]="'Reproducir ' + track().title">{{ track().title }}</button>
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
    @if (showDuration()) { <time>{{ track().durationMs / 60000 | number:'1.0-0' }} min</time> }
  `,
})
export class TrackRowComponent {
  public readonly track = input.required<Track>();
  public readonly position = input<number | null>(null);
  public readonly showCover = input(false);
  public readonly showDuration = input(true);
  public readonly playTrack = output<Track>();
}
