import { Component, computed, inject, input } from '@angular/core';
import { PlaybackSyncService } from '../core/playback-sync.service';
import { AppIconComponent } from './app-icon.component';

@Component({
  selector: 'app-repeat-button', imports: [AppIconComponent],
  template: `<button type="button" (click)="cycle()" [disabled]="!playback.snapshot() || !playback.connected() || playback.repeatPending()"
    [class.active]="mode()!=='off'" [attr.aria-pressed]="mode()!=='off'"
    [attr.aria-label]="label()" [attr.title]="label()+' · '+nextLabel()">
    <app-icon [name]="mode()==='one'?'repeat-one':'repeat'" />
    @if(showLabel()){<span>{{mode()==='off'?'Sin repetir':mode()==='all'?'Repetir cola':'Repetir pista'}}</span>}
  </button>`,
  styles: [`:host{display:inline-flex;justify-content:center}button{display:flex;align-items:center;justify-content:center;gap:7px;
    min-width:40px;min-height:40px;border:0;border-radius:9px;padding:8px;color:var(--muted);background:transparent;cursor:pointer}
    button.active{color:var(--accent)}button:hover:not(:disabled){background:var(--accent-soft)}
    button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}button:disabled{opacity:.4;cursor:default}
    app-icon{width:21px;height:21px}span{font-size:12px}`],
})
export class RepeatButtonComponent {
  protected readonly playback = inject(PlaybackSyncService);
  readonly showLabel = input(false);
  protected readonly mode = computed(() => this.playback.snapshot()?.repeatMode ?? 'off');
  protected readonly label = computed(() => this.mode() === 'off' ? 'Repetición desactivada'
    : this.mode() === 'all' ? 'Repetir toda la cola' : 'Repetir esta pista');
  protected readonly nextLabel = computed(() => this.mode() === 'off' ? 'Activar toda la cola'
    : this.mode() === 'all' ? 'Activar esta pista' : 'Desactivar');
  protected cycle(): void {
    void this.playback.setRepeat(this.mode() === 'off' ? 'all' : this.mode() === 'all' ? 'one' : 'off');
  }
}
