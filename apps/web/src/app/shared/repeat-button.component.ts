import { Component, computed, inject, input } from '@angular/core';
import { PlaybackSyncService } from '../core/playback-sync.service';
import { RepeatControlComponent } from './repeat-control.component';

@Component({
  selector: 'app-repeat-button', imports: [RepeatControlComponent],
  template: `<app-repeat-control [mode]="mode()" [showLabel]="showLabel()"
    [disabled]="!playback.snapshot() || !playback.connected() || playback.repeatPending()" (cycle)="cycle()" />`,
  styles: ':host{display:inline-flex;justify-content:center}',
})
export class RepeatButtonComponent {
  protected readonly playback = inject(PlaybackSyncService);
  readonly showLabel = input(false);
  protected readonly mode = computed(() => this.playback.snapshot()?.repeatMode ?? 'off');
  protected cycle(): void {
    void this.playback.setRepeat(this.mode() === 'off' ? 'all' : this.mode() === 'all' ? 'one' : 'off');
  }
}
