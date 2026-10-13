import { DOCUMENT } from '@angular/common';
import { Component, inject, input, output } from '@angular/core';
import { AppIconComponent } from './app-icon.component';
import { playerTime } from './player-bar.component';

/** Shared mobile presentation; no playback or authentication service dependencies. */
@Component({
  selector: 'app-now-playing',
  imports: [AppIconComponent],
  templateUrl: './now-playing.component.html',
  styles: ':host{display:contents}',
})
export class NowPlayingComponent {
  readonly title = input.required<string>();
  readonly artist = input('');
  readonly album = input<string | null>('');
  readonly coverUrl = input<string | null>(null);
  readonly position = input(0);
  readonly duration = input(0);
  readonly playing = input(false);
  readonly canPlay = input(true);
  readonly canNavigate = input(true);
  readonly canSeek = input(true);
  readonly retrySeconds = input(0);
  readonly actionColumns = input(3);
  readonly close = output<void>();
  readonly previous = output<void>();
  readonly toggle = output<void>();
  readonly next = output<void>();
  readonly preview = output<Event>();
  readonly seek = output<Event>();
  protected readonly time = playerTime;
  private readonly document = inject(DOCUMENT);
  private swipeStart: {x: number; y: number} | null = null;
  protected startSwipe(event: PointerEvent): void { this.swipeStart = {x:event.clientX,y:event.clientY}; }
  protected finishSwipe(event: PointerEvent): void {
    const start=this.swipeStart;this.swipeStart=null;
    if(start && event.clientY-start.y>=72 && event.clientY-start.y>Math.abs(event.clientX-start.x)*1.25) this.close.emit();
  }
  protected trapFocus(event: Event, dialog: HTMLElement): void {
    const key=event as KeyboardEvent;
    if(key.key!=='Tab')return;
    const elements=Array.from(dialog.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])')).filter(el=>!el.hasAttribute('hidden'));
    const first=elements[0],last=elements.at(-1);
    if(!first || !last)return;
    if(key.shiftKey && this.document.activeElement===first){key.preventDefault();last.focus();}
    else if(!key.shiftKey && this.document.activeElement===last){key.preventDefault();first.focus();}
  }
}
