import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { LazyCoverDirective } from './lazy-cover.directive';

@Component({
  imports: [LazyCoverDirective],
  template: '<img [appLazyCover]="cover" [coverSize]="320" alt="Portada">',
})
class LazyCoverHostComponent {
  public cover = '/api/music/covers/reference-a';
}

class IntersectionObserverStub {
  public static latest: IntersectionObserverStub;
  public constructor(private readonly callback: IntersectionObserverCallback) {
    IntersectionObserverStub.latest = this;
  }
  public observe(): void {}
  public disconnect(): void {}
  public unobserve(): void {}
  public takeRecords(): IntersectionObserverEntry[] { return []; }
  public readonly root = null;
  public readonly rootMargin = '0px';
  public readonly thresholds = [0];

  public emit(isIntersecting: boolean): void {
    this.callback([{ isIntersecting } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
}

describe('LazyCoverDirective', () => {
  const originalObserver = globalThis.IntersectionObserver;
  const originalCreateObjectUrl = URL.createObjectURL;
  const originalRevokeObjectUrl = URL.revokeObjectURL;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: vi.fn(() => 'blob:hirmos-cover'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      writable: true,
      value: vi.fn(),
    });
    Object.defineProperty(globalThis, 'IntersectionObserver', {
      configurable: true,
      writable: true,
      value: IntersectionObserverStub,
    });
    await TestBed.configureTestingModule({ imports: [LazyCoverHostComponent] }).compileComponents();
  });

  afterEach(() => {
    Object.defineProperty(globalThis, 'IntersectionObserver', {
      configurable: true,
      writable: true,
      value: originalObserver,
    });
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: originalCreateObjectUrl,
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      writable: true,
      value: originalRevokeObjectUrl,
    });
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('retries temporary responses with backoff only while the cover remains visible', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(null, { status: 503, headers: { 'retry-after': '1' } }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      }));
    const fixture = TestBed.createComponent(LazyCoverHostComponent);
    fixture.detectChanges();
    const image = fixture.nativeElement.querySelector('img') as HTMLImageElement;
    const observer = IntersectionObserverStub.latest;

    observer.emit(true);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/api/music/covers/reference-a?size=320');
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(image.src).toContain('blob:hirmos-cover'));

    image.dispatchEvent(new Event('error'));
    observer.emit(false);
    const whileHidden = image.src;
    vi.advanceTimersByTime(60_000);
    expect(image.src).toBe(whileHidden);

    observer.emit(true);
    image.dispatchEvent(new Event('load'));
    fixture.destroy();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:hirmos-cover');
  });
});
