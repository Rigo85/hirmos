import { Component, computed, input, output } from '@angular/core';
import { AppIconComponent } from './app-icon.component';

/** Presentation only: the caller owns the audio, queue and all commands. */
@Component({
  selector: 'app-player-bar',
  imports: [AppIconComponent],
  templateUrl: './player-bar.component.html',
  styles: `:host{display:contents}@media(max-width:760px){.player-bar--no-nav{bottom:0;padding-bottom:env(safe-area-inset-bottom);height:calc(var(--player) + env(safe-area-inset-bottom))}}`,
})
export class PlayerBarComponent {
  readonly title = input('Elige una canción');
  readonly coverUrl = input<string | null>(null);
  readonly hasTrack = input(false);
  readonly playing = input(false);
  readonly canPlay = input(false);
  readonly canNavigate = input(false);
  readonly canSeek = input(false);
  readonly playHint = input<string | null>(null);
  readonly position = input(0);
  readonly duration = input(0);
  readonly volume = input(.8);
  readonly muted = input(false);
  readonly bottomNavigation = input(true);
  readonly label = input('Reproductor');
  readonly seekLabel = input('Posición');
  readonly seekStep = input(1);
  readonly volumeStep = input(.05);
  readonly previous = output<void>();
  readonly toggle = output<void>();
  readonly next = output<void>();
  readonly seek = output<Event>();
  readonly volumeChange = output<Event>();
  readonly mute = output<void>();
  readonly expand = output<void>();
  protected readonly percent = computed(() => this.duration() > 0
    ? Math.min(100, Math.max(0, this.position() / this.duration() * 100)) : 0);
  protected readonly time = playerTime;
}

export function playerTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  return `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`;
}
