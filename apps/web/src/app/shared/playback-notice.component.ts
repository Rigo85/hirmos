import { Component, DestroyRef, effect, inject, input, output } from '@angular/core';
import { AppIconComponent } from './app-icon.component';

@Component({selector:'app-playback-notice',imports:[AppIconComponent],template:`
  <div class="player-feedback player-information" role="status"
    (mouseenter)="hold('pointer',true)" (mouseleave)="hold('pointer',false)"
    (focusin)="hold('focus',true)" (focusout)="hold('focus',false)">
    <span>{{message()}}</span>
    <button type="button" (click)="closed.emit()" aria-label="Cerrar información"><app-icon name="close" /></button>
  </div>
`})
export class PlaybackNoticeComponent {
  readonly message=input.required<string>();
  readonly closed=output<void>();
  private timer:ReturnType<typeof setTimeout>|null=null;
  private readonly holds=new Set<string>();
  private remaining=5000;
  private deadline=0;
  constructor() {
    effect(()=>{this.message();this.clear();this.remaining=5000;this.schedule();});
    inject(DestroyRef).onDestroy(()=>this.clear());
  }
  protected hold(reason:string,active:boolean):void {
    if(active) {
      if(this.timer!==null) this.remaining=Math.max(0,this.deadline-Date.now());
      this.clear();this.holds.add(reason);
    } else {this.holds.delete(reason);this.schedule();}
  }
  private clear():void {if(this.timer!==null)clearTimeout(this.timer);this.timer=null;}
  private schedule():void {
    if(this.holds.size || this.timer!==null)return;
    this.deadline=Date.now()+this.remaining;
    this.timer=setTimeout(()=>{this.timer=null;this.closed.emit();},this.remaining);
  }
}
