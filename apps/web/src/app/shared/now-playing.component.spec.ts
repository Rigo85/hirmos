import { TestBed } from '@angular/core/testing';
import { NowPlayingComponent } from './now-playing.component';

afterEach(()=>TestBed.resetTestingModule());
function setup(){
  TestBed.configureTestingModule({imports:[NowPlayingComponent]});
  const fixture=TestBed.createComponent(NowPlayingComponent);
  fixture.componentRef.setInput('title','Synthetic track');fixture.detectChanges();
  return {fixture,root:fixture.nativeElement as HTMLElement};
}
it('traps keyboard focus within the shared mobile dialog',()=>{
  const {root}=setup();
  const first=root.querySelector<HTMLButtonElement>('.mobile-now-playing__close')!;
  const last=root.querySelector<HTMLButtonElement>('[aria-label="Siguiente"]')!;
  first.focus();first.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',shiftKey:true,bubbles:true,cancelable:true}));
  expect(document.activeElement).toBe(last);
  last.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}));
  expect(document.activeElement).toBe(first);
});
it('closes for downward swipe, not a horizontal gesture',()=>{
  const {root,fixture}=setup(),closed=vi.fn();
  fixture.componentInstance.close.subscribe(closed);
  const header=root.querySelector('header')!;
  const pointer=(type:string,x:number,y:number)=>header.dispatchEvent(new MouseEvent(type,{clientX:x,clientY:y,bubbles:true}));
  pointer('pointerdown',10,10);pointer('pointerup',200,30);expect(closed).not.toHaveBeenCalled();
  pointer('pointerdown',10,10);pointer('pointerup',15,100);expect(closed).toHaveBeenCalledOnce();
});
