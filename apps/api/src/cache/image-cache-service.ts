import { createHash } from 'node:crypto';
import type { SourceMedia } from '../music-source/music-source-adapter.js';
import { MusicSourceHttpError } from '../music-source/navidrome-adapter.js';
import { CacheRepository } from './cache-repository.js';
import { ObjectStore } from './object-store.js';

const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const REVALIDATE_AFTER_MS = 30 * 24 * 60 * 60 * 1_000;
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
}

export interface ImageRequest {
  sourceId: string;
  remoteId: string;
  size: number;
  load: (signal: AbortSignal) => Promise<SourceMedia>;
}

export class ImageCacheService {
  private readonly inFlight = new Map<string, Promise<SourceMedia>>();
  private readonly refreshing = new Map<string, Promise<void>>();
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

  public async warm(input: ImageRequest): Promise<void> {
    await this.resolve(input, false);
  }

  private async resolve(input: ImageRequest, foreground: boolean): Promise<SourceMedia> {
    const key = imageKey(input.sourceId, input.remoteId, input.size);
    const existing = this.inFlight.get(key);
    if (existing) return foreground ? this.waitForForeground(existing) : existing;

    const cached = await this.readCached(key, input, foreground);
    if (cached) return cached;

    const operationAfterRead = this.inFlight.get(key);
    if (operationAfterRead) {
      return foreground ? this.waitForForeground(operationAfterRead) : operationAfterRead;
    }
    if (this.inFlight.size >= (this.options.maxPending ?? DEFAULT_MAX_PENDING)) {
      throw new ImageCachePendingError(this.retryDelay());
    }

    // Cache filling owns its timeout. A browser request may stop waiting while
    // the bounded job continues, so another retry can consume the completed
    // object instead of starting the same expensive upstream request again.
    const operation = this.fetchAndStore(key, input).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, operation);
    return foreground ? this.waitForForeground(operation) : operation;
  }

  private async readCached(
    key: string,
    input: ImageRequest,
    revalidateInBackground: boolean,
  ): Promise<SourceMedia | null> {
    const cached = await this.repository.get('image', key);
    if (cached) {
      try {
        const bytes = await this.store.read(cached.relativePath, cached.contentHash);
        if ((this.lastTouch.get(key) ?? 0) < Date.now() - 60 * 60 * 1_000) {
          this.lastTouch.set(key, Date.now());
          void this.repository.touch('image', key).catch(() => undefined);
        }
        if (cached.fetchedAt && cached.fetchedAt.valueOf() < Date.now() - REVALIDATE_AFTER_MS) {
          if (revalidateInBackground) {
            this.revalidate(key, input);
            return mediaFromBytes(bytes, cached.contentType, cached.contentHash);
          }
          return null;
        }
        return mediaFromBytes(bytes, cached.contentType, cached.contentHash);
      } catch { /* A missing/corrupt object is safely reconstructed below. */ }
    }
    return null;
  }

  private revalidate(
    key: string,
    input: ImageRequest,
  ): void {
    if (this.refreshing.has(key)) return;
    const operation = this.fetchAndStore(key, input)
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => this.refreshing.delete(key));
    this.refreshing.set(key, operation);
  }

  private async fetchAndStore(
    key: string,
    input: ImageRequest,
  ): Promise<SourceMedia> {
    await this.waitForCooldown();
    await this.acquire();
    try {
      await this.waitForCooldown();
      const upstream = await input.load(AbortSignal.timeout(
        this.options.fillTimeoutMs ?? DEFAULT_FILL_TIMEOUT_MS,
      ));
      const contentType = upstream.contentType?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
      if (!contentType.startsWith('image/')) throw new Error('Music source did not return an image');
      const bytes = await readBounded(upstream.body, MAX_IMAGE_BYTES);
      const stored = await this.store.put(bytes);
      await this.repository.put({
        namespace: 'image', key, sourceId: input.sourceId, remoteEntityId: input.remoteId,
        variant: String(input.size), objectHash: stored.hash, relativePath: stored.relativePath,
        contentType, byteLength: stored.byteLength,
      });
      return mediaFromBytes(bytes, contentType, stored.hash);
    } catch (error) {
      if (isTransientFillError(error)) {
        const retryAfterMs = error instanceof MusicSourceHttpError
          ? error.retryAfterMs ?? 5_000
          : DEFAULT_RETRY_AFTER_MS;
        this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + retryAfterMs);
      }
      throw error;
    } finally {
      this.release();
    }
  }

  private async waitForForeground(operation: Promise<SourceMedia>): Promise<SourceMedia> {
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

  private async waitForCooldown(): Promise<void> {
    const delay = this.cooldownUntil - Date.now();
    if (delay > 0) await abortableDelay(delay + Math.round(250 * this.random()));
  }

  private retryDelay(error?: unknown): number {
    const providerDelay = error instanceof MusicSourceHttpError ? error.retryAfterMs : null;
    const base = Math.max(DEFAULT_RETRY_AFTER_MS, providerDelay ?? 0);
    return base + Math.round(base * 0.25 * this.random());
  }

  private random(): number {
    return Math.max(0, Math.min(1, (this.options.random ?? Math.random)()));
  }

  private async acquire(): Promise<void> {
    if (this.active < this.concurrency) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active += 1;
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1);
    this.waiting.shift()?.();
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

function imageKey(sourceId: string, remoteId: string, size: number): string {
  return createHash('sha256').update(`${sourceId}\0${remoteId}\0${size}`).digest('hex');
}

async function readBounded(stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    length += result.value.byteLength;
    if (length > limit) {
      await reader.cancel().catch(() => undefined);
      throw new Error('Image exceeds cache size limit');
    }
    chunks.push(result.value);
  }
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

function abortableDelay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
