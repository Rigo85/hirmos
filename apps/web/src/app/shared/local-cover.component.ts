import { Component, effect, inject, input, signal } from '@angular/core';
import { SessionStore } from '../core/session.store';
import { LocalExtrasService } from '../offline/local-extras.service';

@Component({
  selector:'app-local-cover',
  template:`@if(url()){<img [src]="url()" alt="" (error)="url.set(null)">}@else{<ng-content />}`,
  styles:`:host{display:contents}img{display:block;width:100%;height:100%;object-fit:cover}`,
})
export class LocalCoverComponent {
  readonly reference=input<string|null>(null);
  readonly revision=input(0);
  protected readonly url=signal<string|null>(null);
  private readonly session=inject(SessionStore);
  private readonly extras=inject(LocalExtrasService);
  constructor(){effect(cleanup=>{
    const owner=this.session.localOwner(),reference=this.reference();this.revision();
    this.url.set(null);let cancelled=false,url:string|null=null;
    cleanup(()=>{cancelled=true;if(url)URL.revokeObjectURL(url);});
    if(!owner||!reference)return;
    void this.extras.cover(owner,reference).then(blob=>{
      if(cancelled||!blob)return;
      url=URL.createObjectURL(blob);this.url.set(url);
    });
  });}
}
