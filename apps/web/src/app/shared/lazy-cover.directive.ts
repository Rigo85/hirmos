import { Directive, ElementRef, HostListener, Input, OnChanges, OnDestroy, OnInit, SimpleChanges, inject } from '@angular/core';

const MAX_RETRIES = 7;
const BASE_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;
const RECHECK_ON_RETURN_MS = 30_000;
const REQUEST_TIMEOUT_MS = 15_000;

@Directive({
  selector: 'img[appLazyCover]',
})
export class LazyCoverDirective implements OnInit, OnChanges, OnDestroy {
  private readonly element = inject<ElementRef<HTMLImageElement>>(ElementRef);
  private observer: IntersectionObserver | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private visible = false;
  private loaded = false;
  private attempts = 0;
  private requestController: AbortController | null = null;
  private objectUrl: string | null = null;
  private etag: string | null = null;
  private refreshPending = false;
  private lastRequestAt = 0;
  private initialized = false;

  @Input({ required: true }) public appLazyCover = '';
  @Input() public coverSize = 320;

  public ngOnInit(): void {
    this.initialized = true;
    const image = this.element.nativeElement;
    image.loading = 'lazy';
    image.decoding = 'async';
    if (!('IntersectionObserver' in globalThis)) {
      this.visible = true;
      this.load();
      return;
    }
    this.observer = new IntersectionObserver((entries) => {
      this.visible = entries.some((entry) => entry.isIntersecting);
      if (!this.visible) {
        this.clearRetry();
        this.requestController?.abort();
        return;
      }
      if (this.attempts === 0) this.load();
      else if (!this.loaded && !this.retryTimer) this.scheduleRetry();
    }, { rootMargin: '400px 0px' });
    this.observer.observe(image);
  }

  public ngOnChanges(changes: SimpleChanges): void {
    if (!this.initialized || (!changes['appLazyCover'] && !changes['coverSize'])) return;
    this.clearRetry();
    this.requestController?.abort();
    this.requestController = null;
    this.attempts = 0;
    this.loaded = false;
    this.refreshPending = false;
    this.etag = null;
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = null;
    this.element.nativeElement.removeAttribute('src');
    if (this.visible) this.load();
  }

  @HostListener('window:focus')
  @HostListener('document:visibilitychange')
  public recheckOnReturn(): void {
    if (document.visibilityState === 'hidden' || !this.visible || !this.loaded
      || this.requestController || Date.now() - this.lastRequestAt < RECHECK_ON_RETURN_MS) return;
    this.attempts = 0;
    this.load(true);
  }

  public ngOnDestroy(): void {
    this.observer?.disconnect();
    this.clearRetry();
    this.requestController?.abort();
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
  }

  @HostListener('load')
  public onLoad(): void {
    this.loaded = true;
    if (!this.refreshPending) this.clearRetry();
  }

  @HostListener('error')
  public onError(): void {
    this.loaded = false;
    if (this.visible) this.scheduleRetry();
  }

  private load(revalidate = false): void {
    if (!this.appLazyCover || (this.loaded && !revalidate) || this.requestController || this.attempts > MAX_RETRIES) return;
    this.clearRetry();
    this.attempts += 1;
    this.lastRequestAt = Date.now();
    const url = new URL(this.appLazyCover, globalThis.location?.origin ?? 'http://localhost');
    url.searchParams.set('size', String(this.coverSize));
    const controller = new AbortController();
    this.requestController = controller;
    const timeout = setTimeout(() => controller.abort(new DOMException('Image request timed out', 'TimeoutError')), REQUEST_TIMEOUT_MS);
    void fetch(`${url.pathname}${url.search}${url.hash}`, {
      credentials: 'same-origin',
      cache: 'no-cache',
      headers: this.etag ? { 'If-None-Match': this.etag } : undefined,
      signal: controller.signal,
    }).then(async (response) => {
      if (controller.signal.aborted || this.requestController !== controller) return;
      this.refreshPending = response.headers.get('x-hirmos-image-refresh') === 'pending';
      if (response.status === 304 && this.objectUrl) {
        if (this.refreshPending) this.scheduleRetry();
        return;
      }
      if (!response.ok) {
        if (response.status === 408 || response.status === 425 || response.status === 429
          || response.status >= 500) {
          this.scheduleRetry(parseRetryAfter(response.headers.get('retry-after')));
        }
        return;
      }
      const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
      if (!contentType.startsWith('image/')) {
        this.scheduleRetry();
        return;
      }
      const blob = await response.blob();
      if (controller.signal.aborted || this.requestController !== controller) return;
      const etag = response.headers.get('etag');
      if (etag && etag === this.etag && this.objectUrl) {
        if (this.refreshPending) this.scheduleRetry();
        return;
      }
      if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = URL.createObjectURL(blob);
      this.etag = etag;
      this.element.nativeElement.src = this.objectUrl;
      if (this.refreshPending) this.scheduleRetry();
    }).catch((error: unknown) => {
      if (this.requestController === controller && ((!controller.signal.aborted && isRetryableNetworkError(error))
        || controller.signal.reason?.name === 'TimeoutError')) this.scheduleRetry();
    }).finally(() => {
      clearTimeout(timeout);
      if (this.requestController === controller) this.requestController = null;
    });
  }

  private scheduleRetry(providerDelayMs = 0): void {
    if (this.retryTimer || this.attempts > MAX_RETRIES) return;
    const exponent = Math.max(0, this.attempts - 1);
    const base = Math.min(MAX_RETRY_MS, BASE_RETRY_MS * (2 ** exponent));
    const jittered = base + Math.round(base * 0.25 * Math.random());
    const delay = Math.max(providerDelayMs, jittered);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.visible) this.load(true);
    }, delay);
  }

  private clearRetry(): void {
    if (!this.retryTimer) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }
}

function parseRetryAfter(value: string | null): number {
  if (!value) return 0;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
}

function isRetryableNetworkError(error: unknown): boolean {
  return error instanceof TypeError
    || (Boolean(error) && typeof error === 'object'
      && ['TimeoutError', 'NetworkError'].includes(String((error as { name?: unknown }).name)));
}
