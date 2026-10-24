import { createHash } from 'node:crypto';
import type { SourceMedia } from '../music-source/music-source-adapter.js';
import { MusicSourceHttpError } from '../music-source/navidrome-adapter.js';
import { CacheRepository, type CachedObjectEntry } from './cache-repository.js';
import { ObjectStore } from './object-store.js';
import { IMAGE_REVALIDATE_MS, KNOWN_IMAGE_PLACEHOLDERS, imageErrorDelay, placeholderDelay } from './image-refresh-policy.js';

const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const DEFAULT_FOREGROUND_WAIT_MS = 2_000;
const DEFAULT_FILL_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_PENDING = 64;
const DEFAULT_RETRY_AFTER_MS = 2_000;

export class ImageCachePendingError extends Error {
  public constructor(public readonly retryAfterMs: number) {
    super('Image cache fill is still pending');
    this.name = 'ImageCachePendingError';
  }
}

interface ImageCacheOptions {
  foregroundWaitMs?: number;
  fillTimeoutMs?: number;
  maxPending?: number;
  random?: () => number;
  observe?: (event: { outcome: string; elapsedMs: number; size: number; retained?: boolean; code?: string }) => void;
}

interface CachedImage { bytes: Uint8Array; contentType: string; hash: string }

export interface ImageRequest {
  sourceId: string;
  remoteId: string;
  size: number;
  load: (signal: AbortSignal) => Promise<SourceMedia>;
}

export class ImageCacheService {
  private readonly inFlight = new Map<string, Promise<CachedImage>>();
  private readonly forced = new Map<string, Promise<CachedImage>>();
  private readonly lastTouch = new Map<string, number>();
  private readonly waiting: Array<() => void> = [];
  private active = 0;
  private cooldownUntil = 0;

  public constructor(
    private readonly repository: CacheRepository,
    private readonly store: ObjectStore,
    private readonly concurrency = 2,
    private readonly options: ImageCacheOptions = {},
  ) {}

  public async initialize(): Promise<void> {
    await this.store.initialize();
  }

  public async get(input: ImageRequest): Promise<SourceMedia> {
    return this.resolve(input, true);
  }

  public async warm(input: ImageRequest, force = false): Promise<void> {
    if (force) await this.refresh(input);
    else await this.resolve(input, false);
  }

  /** A forced request runs after any older fetch, and repeated requests join it.
   * Readers keep the previous object until a usable replacement is committed. */
  public async refresh(input: ImageRequest): Promise<void> {
    const key = imageKey(input.sourceId, input.remoteId, input.size);
    if (this.forced.has(key)) { await this.forced.get(key); return; }
    if (!this.inFlight.has(key) && this.inFlight.size + this.forced.size >= (this.options.maxPending ?? DEFAULT_MAX_PENDING)) {
      throw new ImageCachePendingError(this.retryDelay());
    }
    const previous = this.inFlight.get(key);
    const operation = (async () => {
      await previous?.catch(() => undefined);
      return this.fetchAndStore(key, input);
    })().finally(() => this.forced.delete(key));
    this.forced.set(key, operation);
    await operation;
  }

  private async resolve(input: ImageRequest, foreground: boolean): Promise<SourceMedia> {
    const key = imageKey(input.sourceId, input.remoteId, input.size);
    const cached = await this.readCached(key);
    if (cached && (foreground || !this.forced.has(key))) {
      const due = this.isDue(cached.entry);
      if (foreground) {
        if (due) void this.start(key, input).catch(() => undefined); // fetchAndStore records the result
        return { ...mediaFromBytes(cached.image.bytes, cached.image.contentType, cached.image.hash),
          imageRefreshPending: this.inFlight.has(key) || this.forced.has(key) };
      }
      if (!due) return mediaFromBytes(cached.image.bytes, cached.image.contentType, cached.image.hash);
    }
    const operation = this.start(key, input);
    const image = foreground ? await this.waitForForeground(operation) : await operation;
    return mediaFromBytes(image.bytes, image.contentType, image.hash);
  }

  private isDue(cached: CachedObjectEntry): boolean {
    if (cached.nextRefreshAt) return cached.nextRefreshAt.valueOf() <= Date.now();
    if (KNOWN_IMAGE_PLACEHOLDERS.has(cached.contentHash)) return true;
    return !!cached.fetchedAt && cached.fetchedAt.valueOf() < Date.now() - IMAGE_REVALIDATE_MS;
  }

  private async readCached(key: string): Promise<{ entry: CachedObjectEntry; image: CachedImage } | null> {
    const cached = await this.repository.get('image', key);
    if (cached) {
      try {
        const bytes = await this.store.read(cached.relativePath, cached.contentHash);
        if ((this.lastTouch.get(key) ?? 0) < Date.now() - 60 * 60 * 1_000) {
          this.lastTouch.set(key, Date.now());
          void this.repository.touch('image', key).catch(() => undefined);
        }
        return { entry: cached, image: { bytes, contentType: cached.contentType, hash: cached.contentHash } };
      } catch { /* A missing/corrupt object is safely reconstructed below. */ }
    }
    return null;
  }

  private start(key: string, input: ImageRequest): Promise<CachedImage> {
    const existing = this.forced.get(key) ?? this.inFlight.get(key);
    if (existing) return existing;
    if (this.inFlight.size + this.forced.size >= (this.options.maxPending ?? DEFAULT_MAX_PENDING)) {
      return Promise.reject(new ImageCachePendingError(this.retryDelay()));
    }
    const operation = this.fetchAndStore(key, input).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, operation);
    return operation;
  }

  private async fetchAndStore(
    key: string,
    input: ImageRequest,
  ): Promise<CachedImage> {
    const started = Date.now();
    const signal = AbortSignal.timeout(this.options.fillTimeoutMs ?? DEFAULT_FILL_TIMEOUT_MS);
    this.checkCooldown();
    await this.acquire(signal);
    let previous: CachedObjectEntry | null = null;
    try {
      this.checkCooldown();
      previous = await this.repository.get('image', key);
      const upstream = await abortable(input.load(signal), signal);
      const contentType = upstream.contentType?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
      if (!contentType.startsWith('image/')) throw new Error('Music source did not return an image');
      const bytes = await readBounded(upstream.body, MAX_IMAGE_BYTES, signal);
      if (!bytes.length) throw new Error('Music source returned an empty image');
      const hash = createHash('sha256').update(bytes).digest('hex');
      const placeholder = KNOWN_IMAGE_PLACEHOLDERS.has(hash);
      const attempts = placeholder ? (previous?.imageLastResult === 'placeholder' ? previous.imageAttempts ?? 0 : 0) + 1 : 0;
      const retained = placeholder && previous && !KNOWN_IMAGE_PLACEHOLDERS.has(previous.contentHash)
        ? await this.readCached(key) : null;
      const published = await this.repository.publishImage(key, previous?.revision ?? null, async (repository) => {
        if (retained) {
          await repository.recordImageAttempt(key, 'placeholder', attempts, placeholderDelay(attempts, this.random()));
          return retained.image;
        }
        const object = await this.store.put(bytes);
        await repository.put({
          namespace: 'image', key, sourceId: input.sourceId, remoteEntityId: input.remoteId,
          variant: String(input.size), objectHash: object.hash, relativePath: object.relativePath,
          contentType, byteLength: object.byteLength,
        });
        await repository.recordImageAttempt(key, placeholder ? 'placeholder' : 'image', attempts,
          placeholder ? placeholderDelay(attempts, this.random()) : IMAGE_REVALIDATE_MS);
        return { bytes, contentType, hash: object.hash };
      });
      this.options.observe?.({ outcome: published.published ? (placeholder ? 'placeholder' : 'image') : 'superseded',
        elapsedMs: Date.now() - started, size: input.size, retained: !!retained });
      if (published.value) return published.value;
      const winner = await this.readCached(key);
      if (winner) return winner.image;
      throw new ImageCachePendingError(this.retryDelay());
    } catch (error) {
      if (isTransientFillError(error)) {
        const retryAfterMs = error instanceof MusicSourceHttpError
          ? error.retryAfterMs ?? 5_000
          : DEFAULT_RETRY_AFTER_MS;
        this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + retryAfterMs);
      }
      if (!(error instanceof ImageCachePendingError)) {
        const attempts = (previous?.imageLastResult === 'error' ? previous.imageAttempts ?? 0 : 0) + 1;
        const permanent = error instanceof MusicSourceHttpError && error.status >= 400 && error.status < 500
          && ![408, 425, 429].includes(error.status);
        const delay = Math.max(permanent ? IMAGE_REVALIDATE_MS : imageErrorDelay(attempts, this.random()),
          error instanceof MusicSourceHttpError ? error.retryAfterMs ?? 0 : 0);
        if (previous) await this.repository.publishImage(key, previous.revision ?? null,
          repository => repository.recordImageAttempt(key, 'error', attempts, delay));
        this.options.observe?.({ outcome: 'error', elapsedMs: Date.now() - started, size: input.size,
          retained: !!previous, code: error instanceof MusicSourceHttpError ? `HTTP_${error.status}` : 'IMAGE_FETCH_FAILED' });
      }
      throw error;
    } finally {
      this.release();
    }
  }

  private async waitForForeground(operation: Promise<CachedImage>): Promise<CachedImage> {
    const waitMs = this.options.foregroundWaitMs ?? DEFAULT_FOREGROUND_WAIT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new ImageCachePendingError(this.retryDelay())), waitMs);
        }),
      ]);
    } catch (error) {
      if (isTransientFillError(error)) throw new ImageCachePendingError(this.retryDelay(error));
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private checkCooldown(): void {
    const delay = this.cooldownUntil - Date.now();
    if (delay > 0) throw new ImageCachePendingError(delay);
  }

  private retryDelay(error?: unknown): number {
    const providerDelay = error instanceof MusicSourceHttpError ? error.retryAfterMs : null;
    const base = Math.max(DEFAULT_RETRY_AFTER_MS, providerDelay ?? 0);
    return base + Math.round(base * 0.25 * this.random());
  }

  private random(): number {
    return Math.max(0, Math.min(1, (this.options.random ?? Math.random)()));
  }

  private async acquire(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.active < this.concurrency) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const waiting = () => { signal.removeEventListener('abort', abort); resolve(); };
      const abort = () => {
        const index = this.waiting.indexOf(waiting);
        if (index >= 0) this.waiting.splice(index, 1);
        reject(signal.reason);
      };
      signal.addEventListener('abort', abort, { once: true });
      this.waiting.push(waiting);
    });
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) next(); // Transfer the occupied slot; do not let a new caller steal it.
    else this.active = Math.max(0, this.active - 1);
  }
}

function isTransientFillError(error: unknown): boolean {
  if (error instanceof ImageCachePendingError) return true;
  if (error instanceof MusicSourceHttpError) return error.status === 408
    || error.status === 425 || error.status === 429 || error.status >= 500;
  if (!error || typeof error !== 'object') return false;
  const value = error as { name?: unknown; code?: unknown };
  return value.name === 'TimeoutError' || value.name === 'AbortError'
    || value.name === 'TypeError' || typeof value.code === 'string';
}

export function imageKey(sourceId: string, remoteId: string, size: number): string {
  return createHash('sha256').update(`${sourceId}\0${remoteId}\0${size}`).digest('hex');
}

async function readBounded(stream: ReadableStream<Uint8Array>, limit: number, signal: AbortSignal): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try { while (true) {
    const result = await abortable(reader.read(), signal);
    if (result.done) break;
    length += result.value.byteLength;
    if (length > limit) {
        void reader.cancel().catch(() => undefined);
      throw new Error('Image exceeds cache size limit');
    }
    chunks.push(result.value);
  } } catch (error) { void reader.cancel().catch(() => undefined); throw error; }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function mediaFromBytes(bytes: Uint8Array, contentType: string, hash: string): SourceMedia {
  return {
    status: 200,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    contentType,
    contentLength: String(bytes.byteLength),
    contentRange: null,
    acceptRanges: null,
    etag: `"sha256-${hash}"`,
  };
}

async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let listener: (() => void) | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      listener = () => reject(signal.reason);
      if (signal.aborted) listener();
      else signal.addEventListener('abort', listener, { once: true });
    })]);
  } finally { if (listener) signal.removeEventListener('abort', listener); }
}
