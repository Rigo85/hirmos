import { Component, computed, input, output } from '@angular/core';
import type { RepeatMode } from '@hirmos/contracts';
import { AppIconComponent } from './app-icon.component';

/** Same presentation in either mode; the parent decides where the command goes. */
@Component({
  selector: 'app-repeat-control', imports: [AppIconComponent],
  template: `<button type="button" (click)="cycle.emit()" [disabled]="disabled()"
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
export class RepeatControlComponent {
  readonly mode = input<RepeatMode>('off');
  readonly disabled = input(false);
  readonly showLabel = input(false);
  readonly cycle = output<void>();
  protected readonly label = computed(() => this.mode() === 'off' ? 'Repetición desactivada'
    : this.mode() === 'all' ? 'Repetir toda la cola' : 'Repetir esta pista');
  protected readonly nextLabel = computed(() => this.mode() === 'off' ? 'Activar toda la cola'
    : this.mode() === 'all' ? 'Activar esta pista' : 'Desactivar');
}
