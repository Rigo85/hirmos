import { TestBed } from '@angular/core/testing';
import { PlaybackNoticeComponent } from './playback-notice.component';

describe('playback information notice',()=>{
  afterEach(()=>vi.useRealTimers());
  async function view(){
    vi.useFakeTimers();
    await TestBed.configureTestingModule({imports:[PlaybackNoticeComponent]}).compileComponents();
    const f=TestBed.createComponent(PlaybackNoticeComponent);
    f.componentRef.setInput('message','2 añadidas · 3 repetidas omitidas');f.detectChanges();
    const close=vi.fn();f.componentInstance.closed.subscribe(close);
    return {f,close,box:f.nativeElement.querySelector('[role=status]') as HTMLElement};
  }
  it('is neutral information and expires after five seconds',async()=>{
    const {f,close,box}=await view();expect(box.classList.contains('player-information')).toBe(true);
    expect(f.nativeElement.querySelector('[role=alert]')).toBeNull();
    vi.advanceTimersByTime(4999);expect(close).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);expect(close).toHaveBeenCalledTimes(1);f.destroy();
  });
  it('pauses for pointer and focus independently',async()=>{
    const {f,close,box}=await view();vi.advanceTimersByTime(2000);
    box.dispatchEvent(new Event('mouseenter'));box.dispatchEvent(new Event('focusin'));
    vi.advanceTimersByTime(10000);box.dispatchEvent(new Event('mouseleave'));
    vi.advanceTimersByTime(10000);expect(close).not.toHaveBeenCalled();
    box.dispatchEvent(new Event('focusout'));vi.advanceTimersByTime(3000);
    expect(close).toHaveBeenCalledTimes(1);f.destroy();
  });
  it('resets for a new message and cancels the timer on destroy',async()=>{
    const {f,close}=await view();vi.advanceTimersByTime(4500);
    f.componentRef.setInput('message','Estas canciones ya están en la cola.');f.detectChanges();
    vi.advanceTimersByTime(1000);expect(close).not.toHaveBeenCalled();f.destroy();
    vi.advanceTimersByTime(10000);expect(close).not.toHaveBeenCalled();
  });
});
