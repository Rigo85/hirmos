import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CacheRepository, CachedObjectEntry } from '../src/cache/cache-repository.js';
import { ImageCachePendingError, ImageCacheService } from '../src/cache/image-cache-service.js';
import { ObjectStore } from '../src/cache/object-store.js';
import type { SourceMedia } from '../src/music-source/music-source-adapter.js';
import { MusicSourceHttpError } from '../src/music-source/navidrome-adapter.js';
import { KNOWN_IMAGE_PLACEHOLDERS } from '../src/cache/image-refresh-policy.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe('ImageCacheService', () => {
  it('deduplicates concurrent misses and serves later requests from the object store', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hirmos-image-cache-'));
    temporaryDirectories.push(root);
    let entry: CachedObjectEntry | null = null;
    const repository = {
      get: vi.fn(async () => entry),
      put: vi.fn(async (input: {
        relativePath: string; contentHash: string; objectHash: string;
        contentType: string; byteLength: number;
      }) => {
        entry = {
          relativePath: input.relativePath,
          contentHash: input.objectHash,
          contentType: input.contentType,
          byteLength: input.byteLength,
        };
      }),
      touch: vi.fn(async () => undefined),
    } as unknown as CacheRepository;
    const cache = new ImageCacheService(withLifecycle(repository), new ObjectStore(root), 2);
    await cache.initialize();
    const load = vi.fn(async () => imageMedia(new Uint8Array([1, 2, 3])));

    const first = await Promise.all(Array.from({ length: 8 }, () => cache.get({
      sourceId: 'source-a', remoteId: 'cover-a', size: 320, load,
    })));
    expect(load).toHaveBeenCalledTimes(1);
    for (const response of first) expect(await body(response)).toEqual(new Uint8Array([1, 2, 3]));

    const cached = await cache.get({ sourceId: 'source-a', remoteId: 'cover-a', size: 320, load });
    expect(load).toHaveBeenCalledTimes(1);
    expect(await body(cached)).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('does not cache a successful non-image response', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hirmos-image-cache-'));
    temporaryDirectories.push(root);
    const repository = {
      get: vi.fn(async () => null), put: vi.fn(), touch: vi.fn(),
    } as unknown as CacheRepository;
    const cache = new ImageCacheService(withLifecycle(repository), new ObjectStore(root));
    await cache.initialize();

    await expect(cache.get({
      sourceId: 'source-a', remoteId: 'cover-a', size: 320,
      load: async () => ({ ...imageMedia(new Uint8Array([60, 120, 109, 108, 62])), contentType: 'text/xml' }),
    })).rejects.toThrow('did not return an image');
    expect(repository.put).not.toHaveBeenCalled();
  });

  it('lets the foreground request return while the bounded cache fill continues', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hirmos-image-cache-'));
    temporaryDirectories.push(root);
    let entry: CachedObjectEntry | null = null;
    const repository = {
      get: vi.fn(async () => entry),
      put: vi.fn(async (input: { relativePath: string; objectHash: string; contentType: string; byteLength: number }) => {
        entry = {
          relativePath: input.relativePath,
          contentHash: input.objectHash,
          contentType: input.contentType,
          byteLength: input.byteLength,
        };
      }),
      touch: vi.fn(async () => undefined),
    } as unknown as CacheRepository;
    const cache = new ImageCacheService(withLifecycle(repository), new ObjectStore(root), 1, {
      foregroundWaitMs: 5,
      random: () => 0,
    });
    await cache.initialize();
    let complete!: (media: SourceMedia) => void;
    const load = vi.fn((_signal: AbortSignal) => new Promise<SourceMedia>((resolve) => {
      complete = resolve;
    }));

    await expect(cache.get({
      sourceId: 'source-a', remoteId: 'slow-cover', size: 320, load,
    })).rejects.toBeInstanceOf(ImageCachePendingError);
    expect(load).toHaveBeenCalledTimes(1);

    complete(imageMedia(new Uint8Array([4, 5, 6])));
    await vi.waitFor(() => expect(repository.put).toHaveBeenCalledTimes(1));
    const cached = await cache.get({
      sourceId: 'source-a', remoteId: 'slow-cover', size: 320, load,
    });
    expect(load).toHaveBeenCalledTimes(1);
    expect(await body(cached)).toEqual(new Uint8Array([4, 5, 6]));
  });

  it('queues distinct cold images without exceeding upstream concurrency', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hirmos-image-cache-'));
    temporaryDirectories.push(root);
    const repository = {
      get: vi.fn(async () => null), put: vi.fn(async () => undefined), touch: vi.fn(),
    } as unknown as CacheRepository;
    const cache = new ImageCacheService(withLifecycle(repository), new ObjectStore(root), 1, {
      foregroundWaitMs: 5,
      random: () => 0,
    });
    await cache.initialize();
    const completions: Array<(media: SourceMedia) => void> = [];
    let active = 0;
    let maximumActive = 0;
    const load = vi.fn((_signal: AbortSignal) => new Promise<SourceMedia>((resolve) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      completions.push((media) => {
        active -= 1;
        resolve(media);
      });
    }));

    const first = cache.get({ sourceId: 'source-a', remoteId: 'cover-a', size: 320, load });
    const second = cache.get({ sourceId: 'source-a', remoteId: 'cover-b', size: 320, load });
    await expect(first).rejects.toBeInstanceOf(ImageCachePendingError);
    await expect(second).rejects.toBeInstanceOf(ImageCachePendingError);
    expect(load).toHaveBeenCalledTimes(1);
    expect(maximumActive).toBe(1);

    completions.shift()!(imageMedia(new Uint8Array([1])));
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    completions.shift()!(imageMedia(new Uint8Array([2])));
    await vi.waitFor(() => expect(repository.put).toHaveBeenCalledTimes(2));
    expect(maximumActive).toBe(1);
  });

  it('absorbs a cold viewport burst without forwarding the burst upstream', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hirmos-image-cache-'));
    temporaryDirectories.push(root);
    const repository = {
      get: vi.fn(async () => null), put: vi.fn(async () => undefined), touch: vi.fn(),
    } as unknown as CacheRepository;
    const cache = new ImageCacheService(withLifecycle(repository), new ObjectStore(root), 2, {
      foregroundWaitMs: 2,
      random: () => 0,
    });
    await cache.initialize();
    let active = 0;
    let maximumActive = 0;
    const load = vi.fn(async (_signal: AbortSignal) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 12));
      active -= 1;
      return imageMedia(new Uint8Array([7, 8, 9]));
    });

    const results = await Promise.allSettled(Array.from({ length: 20 }, (_value, index) => cache.get({
      sourceId: 'source-a', remoteId: `cover-${index}`, size: 320, load,
    })));
    expect(results.every((result) => result.status === 'rejected'
      && result.reason instanceof ImageCachePendingError)).toBe(true);
    await vi.waitFor(() => expect(repository.put).toHaveBeenCalledTimes(20));
    expect(maximumActive).toBe(2);
  });

  it('awaits and replaces a stale object during durable background warming', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hirmos-image-cache-'));
    temporaryDirectories.push(root);
    const store = new ObjectStore(root);
    await store.initialize();
    const previous = await store.put(new Uint8Array([1]));
    let entry: CachedObjectEntry | null = {
      relativePath: previous.relativePath,
      contentHash: previous.hash,
      contentType: 'image/webp',
      byteLength: previous.byteLength,
      fetchedAt: new Date('2020-01-01T00:00:00.000Z'),
    };
    const repository = {
      get: vi.fn(async () => entry),
      put: vi.fn(async (input: {
        relativePath: string; objectHash: string; contentType: string; byteLength: number;
      }) => {
        entry = {
          relativePath: input.relativePath, contentHash: input.objectHash,
          contentType: input.contentType, byteLength: input.byteLength, fetchedAt: new Date(),
        };
      }),
      touch: vi.fn(async () => undefined),
    } as unknown as CacheRepository;
    const cache = new ImageCacheService(withLifecycle(repository), store, 1);
    const load = vi.fn(async () => imageMedia(new Uint8Array([8, 9])));

    await cache.warm({ sourceId: 'source-a', remoteId: 'cover-a', size: 320, load });

    expect(load).toHaveBeenCalledTimes(1);
    expect(repository.put).toHaveBeenCalledTimes(1);
    const refreshed = await cache.get({
      sourceId: 'source-a', remoteId: 'cover-a', size: 320, load,
    });
    expect(await body(refreshed)).toEqual(new Uint8Array([8, 9]));
    expect(load).toHaveBeenCalledTimes(1);
  });
});

describe('image refresh safety', () => {
  it('shares warm and foreground refresh, retaining readable old bytes until completion', async () => {
    const { cache, repository, expire } = await statefulCache();
    const input = { sourceId: 'source', remoteId: 'cover', size: 320, load: async () => imageMedia(new Uint8Array([1])) };
    await cache.warm(input); expire();
    let finish!: (media: SourceMedia) => void;
    const load = vi.fn(() => new Promise<SourceMedia>(resolve => { finish = resolve; }));
    const warming = cache.warm({ ...input, load });
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
    const old = await cache.get({ ...input, load });
    expect(await body(old)).toEqual(new Uint8Array([1]));
    expect(old.imageRefreshPending).toBe(true);
    finish(imageMedia(new Uint8Array([2]))); await warming;
    expect(load).toHaveBeenCalledOnce();
    expect(repository.recordImageAttempt).toHaveBeenLastCalledWith(expect.any(String), 'image', 0, 30 * 86400000);
  });

  it('forces a fresh cached image and coalesces repeated force requests after an older fetch', async () => {
    const { cache, expire } = await statefulCache();
    const input = { sourceId: 'source', remoteId: 'cover', size: 320, load: async () => imageMedia(new Uint8Array([1])) };
    await cache.warm(input); expire();
    let finish!: (media: SourceMedia) => void;
    const older = cache.warm({ ...input, load: () => new Promise(resolve => { finish = resolve; }) });
    await vi.waitFor(() => expect(finish).toBeDefined());
    const load = vi.fn(async () => imageMedia(new Uint8Array([3])));
    const forced = cache.refresh({ ...input, load });
    const joined = cache.refresh({ ...input, load });
    finish(imageMedia(new Uint8Array([2])));
    await Promise.all([older, forced, joined]);
    expect(load).toHaveBeenCalledOnce();
    expect(await body(await cache.get(input))).toEqual(new Uint8Array([3]));
    await cache.refresh({ ...input, load });
    expect(load).toHaveBeenCalledTimes(2); // Explicit refresh bypasses the 30-day freshness.
  });

  it('does not replace a usable image with a known placeholder and spaces further checks', async () => {
    const placeholder = new Uint8Array([99, 88, 77]);
    const hash = createHash('sha256').update(placeholder).digest('hex');
    vi.spyOn(KNOWN_IMAGE_PLACEHOLDERS, 'has').mockImplementation(value => value === hash);
    const { cache, entry } = await statefulCache();
    const input = { sourceId: 'source', remoteId: 'cover', size: 320, load: async () => imageMedia(new Uint8Array([1])) };
    await cache.warm(input);
    const originalFetchedAt = entry()!.fetchedAt;
    const load = vi.fn(async () => imageMedia(placeholder));
    await cache.refresh({ ...input, load });
    expect(await body(await cache.get({ ...input, load }))).toEqual(new Uint8Array([1]));
    expect(entry()!.fetchedAt).toEqual(originalFetchedAt);
    expect(entry()!.imageLastResult).toBe('placeholder');
    expect(entry()!.nextRefreshAt!.valueOf() - Date.now()).toBeGreaterThan(86399000);
    await cache.refresh({ ...input, load });
    expect(entry()!.imageAttempts).toBe(2);
    expect(entry()!.nextRefreshAt!.valueOf() - Date.now()).toBeGreaterThan(172799000);
    await cache.warm({ ...input, load });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('stores a cold placeholder with a short deadline, then promotes it to a photo', async () => {
    const placeholder = new Uint8Array([99]);
    vi.spyOn(KNOWN_IMAGE_PLACEHOLDERS, 'has').mockImplementation(value => value === createHash('sha256').update(placeholder).digest('hex'));
    const { cache, entry, expire } = await statefulCache();
    const input = { sourceId: 'source', remoteId: 'cover', size: 320, load: async () => imageMedia(placeholder) };
    await cache.warm(input);
    expect(entry()!.imageLastResult).toBe('placeholder');
    expire();
    await cache.warm({ ...input, load: async () => imageMedia(new Uint8Array([2])) });
    expect(entry()!.imageLastResult).toBe('image');
    expect(entry()!.imageAttempts).toBe(0);
    expect(await body(await cache.get(input))).toEqual(new Uint8Array([2]));
  });

  it('retains a photo on 429 and persists Retry-After without changing the successful fetch date', async () => {
    const { cache, entry } = await statefulCache();
    const input = { sourceId: 'source', remoteId: 'cover', size: 320, load: async () => imageMedia(new Uint8Array([1])) };
    await cache.warm(input);
    const date = entry()!.fetchedAt;
    const error = new MusicSourceHttpError(429, 120000);
    await expect(cache.refresh({ ...input, load: async () => { throw error; } })).rejects.toBe(error);
    expect(entry()!.fetchedAt).toEqual(date);
    expect(entry()!.imageLastResult).toBe('error');
    expect(entry()!.nextRefreshAt!.valueOf() - Date.now()).toBeGreaterThan(119000);
    expect(await body(await cache.get(input))).toEqual(new Uint8Array([1]));
  });

  it('bounds a stalled response body and cancels it without storing partial bytes', async () => {
    const { cache, entry } = await statefulCache({ fillTimeoutMs: 20 });
    const cancel = vi.fn();
    const load = async () => ({ ...imageMedia(new Uint8Array([1])), body: new ReadableStream<Uint8Array>({ cancel }) });
    await expect(cache.warm({ sourceId: 'source', remoteId: 'cover', size: 320, load })).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(cancel).toHaveBeenCalledOnce();
    expect(entry()).toBeNull();
  });

  it('rejects a late publication from another cache instance', async () => {
    const { cache, repository, store, entry } = await statefulCache();
    const other = new ImageCacheService(repository, store, 1, { random: () => 0 });
    const input = { sourceId: 'source', remoteId: 'cover', size: 320, load: async () => imageMedia(new Uint8Array([1])) };
    await cache.warm(input);
    let finish!: (media: SourceMedia) => void;
    const late = cache.refresh({ ...input, load: () => new Promise(resolve => { finish = resolve; }) });
    await vi.waitFor(() => expect(finish).toBeDefined());
    await other.refresh({ ...input, load: async () => imageMedia(new Uint8Array([3])) });
    const revision = entry()!.revision;
    finish(imageMedia(new Uint8Array([2]))); await late;
    expect(entry()!.revision).toBe(revision);
    expect(await body(await cache.get(input))).toEqual(new Uint8Array([3]));
  });
});

async function statefulCache(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'hirmos-image-refresh-'));
  temporaryDirectories.push(root);
  const store = new ObjectStore(root);
  await store.initialize();
  let entry: CachedObjectEntry | null = null;
  const repository = {
    get: vi.fn(async () => entry ? { ...entry } : null),
    put: vi.fn(async (input: { relativePath: string; objectHash: string; contentType: string; byteLength: number }) => {
      entry = { relativePath: input.relativePath, contentHash: input.objectHash, contentType: input.contentType,
        byteLength: input.byteLength, fetchedAt: new Date(), revision: String(Number(entry?.revision ?? 0) + 1) };
    }),
    touch: vi.fn(async () => undefined),
    recordImageAttempt: vi.fn(async (_key: string, result: CachedObjectEntry['imageLastResult'], attempts: number, delay: number) => {
      if (entry) entry = { ...entry, imageLastResult: result, imageAttempts: attempts,
        nextRefreshAt: new Date(Date.now() + delay), revision: String(Number(entry.revision) + 1) };
    }),
  } as unknown as CacheRepository;
  repository.publishImage = async (_key, expected, operation) => {
    if ((entry?.revision ?? null) !== expected) return { published: false };
    return { published: true, value: await operation(repository) };
  };
  const cache = new ImageCacheService(repository, store, 2, { random: () => 0, ...options });
  return { cache, repository, store, entry: () => entry,
    expire: () => { if (entry) entry.nextRefreshAt = new Date(0); } };
}

function withLifecycle(repository: CacheRepository): CacheRepository {
  repository.withObjectMutation = async operation => operation(repository);
  repository.publishImage = async (_key, _revision, operation) => ({ published: true, value: await operation(repository) });
  repository.recordImageAttempt = vi.fn(async () => undefined);
  return repository;
}

function imageMedia(bytes: Uint8Array): SourceMedia {
  return {
    status: 200,
    body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }),
    contentType: 'image/webp', contentLength: String(bytes.byteLength),
    contentRange: null, acceptRanges: null,
  };
}

async function body(media: SourceMedia): Promise<Uint8Array> {
  return new Uint8Array(await new Response(media.body).arrayBuffer());
}
