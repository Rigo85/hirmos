import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { LazyCoverDirective } from './lazy-cover.directive';

@Component({
  imports: [LazyCoverDirective],
  template: '<img [appLazyCover]="cover()" [coverSize]="320" alt="Portada">',
})
class LazyCoverHostComponent {
  public cover = signal('/api/music/covers/reference-a');
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

  it('revalidates a warm image with its ETag and keeps its Blob on 304', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(new Uint8Array([1]), { headers: { 'content-type': 'image/png', etag: '"v1"' } }))
      .mockResolvedValueOnce(new Response(null, { status: 304 }));
    const fixture = TestBed.createComponent(LazyCoverHostComponent); fixture.detectChanges();
    IntersectionObserverStub.latest.emit(true);
    const image = fixture.nativeElement.querySelector('img') as HTMLImageElement;
    await vi.waitFor(() => expect(image.src).toContain('blob:'));
    image.dispatchEvent(new Event('load'));
    await vi.advanceTimersByTimeAsync(31000);
    window.dispatchEvent(new Event('focus'));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[1]![1]).toMatchObject({ cache: 'no-cache', headers: { 'If-None-Match': '"v1"' } });
    expect(URL.createObjectURL).toHaveBeenCalledOnce();
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    fixture.destroy();
  });

  it('checks a pending refresh even after the old image loaded, then displays its replacement', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(new Uint8Array([1]), {
        headers: { 'content-type': 'image/png', etag: '"v1"', 'x-hirmos-image-refresh': 'pending' },
      }))
      .mockResolvedValueOnce(new Response(new Uint8Array([2]), { headers: { 'content-type': 'image/png', etag: '"v2"' } }));
    const fixture = TestBed.createComponent(LazyCoverHostComponent); fixture.detectChanges();
    const image = fixture.nativeElement.querySelector('img') as HTMLImageElement;
    IntersectionObserverStub.latest.emit(true);
    await vi.waitFor(() => expect(image.src).toContain('blob:'));
    image.dispatchEvent(new Event('load'));
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(URL.createObjectURL).toHaveBeenCalledTimes(2));
    image.dispatchEvent(new Event('load'));
    await vi.advanceTimersByTimeAsync(60000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fixture.destroy();
  });

  it('ignores a late response after navigating to a different cover', async () => {
    let finish!: (response: Response) => void;
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
      .mockResolvedValueOnce(new Response(new Uint8Array([2]), { headers: { 'content-type': 'image/png', etag: '"new"' } }));
    const fixture = TestBed.createComponent(LazyCoverHostComponent); fixture.detectChanges();
    IntersectionObserverStub.latest.emit(true);
    fixture.componentInstance.cover.set('/api/music/covers/reference-b');
    fixture.changeDetectorRef.markForCheck(); fixture.detectChanges();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(URL.createObjectURL).toHaveBeenCalledOnce());
    expect(String(fetchMock.mock.calls[1]![0])).toContain('reference-b');
    expect(fetchMock.mock.calls[0]![1]!.signal!.aborted).toBe(true);
    finish(new Response(new Uint8Array([1]), { headers: { 'content-type': 'image/png' } }));
    await vi.advanceTimersByTimeAsync(1);
    expect(URL.createObjectURL).toHaveBeenCalledOnce();
    fixture.destroy();
  });

  it('preserves a loaded cover when its revalidation fails and does not retry offscreen', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(new Uint8Array([1]), { headers: { 'content-type': 'image/png', etag: '"v1"' } }))
      .mockResolvedValueOnce(new Response(null, { status: 503, headers: { 'retry-after': '120' } }));
    const fixture = TestBed.createComponent(LazyCoverHostComponent); fixture.detectChanges();
    const image = fixture.nativeElement.querySelector('img') as HTMLImageElement;
    IntersectionObserverStub.latest.emit(true);
    await vi.waitFor(() => expect(image.src).toContain('blob:'));
    image.dispatchEvent(new Event('load'));
    await vi.advanceTimersByTimeAsync(31000); window.dispatchEvent(new Event('focus'));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(image.src).toContain('blob:');
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    IntersectionObserverStub.latest.emit(false);
    await vi.advanceTimersByTimeAsync(120000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fixture.destroy();
  });
});
