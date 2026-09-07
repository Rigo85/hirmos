import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CacheRepository, CachedObjectEntry } from '../src/cache/cache-repository.js';
import { ImageCachePendingError, ImageCacheService } from '../src/cache/image-cache-service.js';
import { ObjectStore } from '../src/cache/object-store.js';
import type { SourceMedia } from '../src/music-source/music-source-adapter.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
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
    const cache = new ImageCacheService(repository, new ObjectStore(root), 2);
    await cache.initialize();
    const load = vi.fn(async () => imageMedia(new Uint8Array([1, 2, 3])));

    const first = await Promise.all(Array.from({ length: 8 }, () => cache.get({
      sourceId: 'source-a', remoteId: 'cover-a', size: 320, load,
    })));
    expect(load).toHaveBeenCalledTimes(1);
    expect(await body(first[0]!)).toEqual(new Uint8Array([1, 2, 3]));

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
    const cache = new ImageCacheService(repository, new ObjectStore(root));
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
    const cache = new ImageCacheService(repository, new ObjectStore(root), 1, {
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
    const cache = new ImageCacheService(repository, new ObjectStore(root), 1, {
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
    const cache = new ImageCacheService(repository, new ObjectStore(root), 2, {
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
    const cache = new ImageCacheService(repository, store, 1);
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
