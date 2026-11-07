import sharp from 'sharp';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
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

const pixels = await Promise.all(Array.from({ length: 100 }, (_, i) => sharp({ create: {
  width: 2, height: 2, channels: 3, background: { r: i, g: 90, b: 120 },
} }).png().toBuffer().then(b => new Uint8Array(b))));
const testImage = (values: number[]) => pixels[values[0] ?? 0]!;
const placeholderBytes = new Uint8Array(await readFile(new URL('./fixtures/images/navidrome-artist-placeholder.webp', import.meta.url)));
const albumPlaceholderBytes = new Uint8Array(await readFile(new URL('./fixtures/images/navidrome-album-placeholder.webp', import.meta.url)));
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
    const load = vi.fn(async () => imageMedia(testImage([1, 2, 3])));

    const first = await Promise.all(Array.from({ length: 8 }, () => cache.get({
      sourceId: 'source-a', remoteId: 'cover-a', size: 320, load,
    })));
    expect(load).toHaveBeenCalledTimes(1);
    for (const response of first) expect(await body(response)).toEqual(testImage([1, 2, 3]));

    const cached = await cache.get({ sourceId: 'source-a', remoteId: 'cover-a', size: 320, load });
    expect(load).toHaveBeenCalledTimes(1);
    expect(await body(cached)).toEqual(testImage([1, 2, 3]));
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
      load: async () => ({ ...imageMedia(testImage([60, 120, 109, 108, 62])), contentType: 'text/xml' }),
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

    complete(imageMedia(testImage([4, 5, 6])));
    await vi.waitFor(() => expect(repository.put).toHaveBeenCalledTimes(1));
    const cached = await cache.get({
      sourceId: 'source-a', remoteId: 'slow-cover', size: 320, load,
    });
    expect(load).toHaveBeenCalledTimes(1);
    expect(await body(cached)).toEqual(testImage([4, 5, 6]));
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

    completions.shift()!(imageMedia(testImage([1])));
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    completions.shift()!(imageMedia(testImage([2])));
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
      return imageMedia(testImage([7, 8, 9]));
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
    const previous = await store.put(testImage([1]));
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
    const load = vi.fn(async () => imageMedia(testImage([8, 9])));

    await cache.warm({ sourceId: 'source-a', remoteId: 'cover-a', size: 320, load });

    expect(load).toHaveBeenCalledTimes(1);
    expect(repository.put).toHaveBeenCalledTimes(1);
    const refreshed = await cache.get({
      sourceId: 'source-a', remoteId: 'cover-a', size: 320, load,
    });
    expect(await body(refreshed)).toEqual(testImage([8, 9]));
    expect(load).toHaveBeenCalledTimes(1);
  });
});

describe('image refresh safety', () => {
  it('shares warm and foreground refresh, retaining readable old bytes until completion', async () => {
    const { cache, repository, expire } = await statefulCache();
    const input = { sourceId: 'source', remoteId: 'cover', size: 320, load: async () => imageMedia(testImage([1])) };
    await cache.warm(input); expire();
    let finish!: (media: SourceMedia) => void;
    const load = vi.fn(() => new Promise<SourceMedia>(resolve => { finish = resolve; }));
    const warming = cache.warm({ ...input, load });
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
    const old = await cache.get({ ...input, load });
    expect(await body(old)).toEqual(testImage([1]));
    expect(old.imageRefreshPending).toBe(true);
    finish(imageMedia(testImage([2]))); await warming;
    expect(load).toHaveBeenCalledOnce();
    expect(repository.recordImageAttempt).toHaveBeenLastCalledWith(expect.any(String), 'image', 0, 30 * 86400000);
  });

  it('forces a fresh cached image and coalesces repeated force requests after an older fetch', async () => {
    const { cache, expire } = await statefulCache();
    const input = { sourceId: 'source', remoteId: 'cover', size: 320, load: async () => imageMedia(testImage([1])) };
    await cache.warm(input); expire();
    let finish!: (media: SourceMedia) => void;
    const older = cache.warm({ ...input, load: () => new Promise(resolve => { finish = resolve; }) });
    await vi.waitFor(() => expect(finish).toBeDefined());
    const load = vi.fn(async () => imageMedia(testImage([3])));
    const forced = cache.refresh({ ...input, load });
    const joined = cache.refresh({ ...input, load });
    finish(imageMedia(testImage([2])));
    await Promise.all([older, forced, joined]);
    expect(load).toHaveBeenCalledOnce();
    expect(await body(await cache.get(input))).toEqual(testImage([3]));
    await cache.refresh({ ...input, load });
    expect(load).toHaveBeenCalledTimes(2); // Explicit refresh bypasses the 30-day freshness.
  });

  it('does not replace a usable image with a known placeholder and spaces further checks', async () => {
    const placeholder = placeholderBytes;
    const { cache, entry } = await statefulCache();
    const input = { sourceId: 'source', remoteId: 'cover', size: 320, load: async () => imageMedia(testImage([1])) };
    await cache.warm(input);
    const originalFetchedAt = entry()!.fetchedAt;
    const load = vi.fn(async () => imageMedia(placeholder));
    await cache.refresh({ ...input, load });
    expect(await body(await cache.get({ ...input, load }))).toEqual(testImage([1]));
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
    const placeholder = placeholderBytes;
    const { cache, entry, expire } = await statefulCache();
    const input = { sourceId: 'source', remoteId: 'cover', size: 320, load: async () => imageMedia(placeholder) };
    await cache.warm(input);
    expect(entry()!.imageLastResult).toBe('placeholder');
    expire();
    await cache.warm({ ...input, load: async () => imageMedia(testImage([2])) });
    expect(entry()!.imageLastResult).toBe('image');
    expect(entry()!.imageAttempts).toBe(0);
    expect(await body(await cache.get(input))).toEqual(testImage([2]));
  });

  it('retains a photo on 429 and persists Retry-After without changing the successful fetch date', async () => {
    const { cache, entry } = await statefulCache();
    const input = { sourceId: 'source', remoteId: 'cover', size: 320, load: async () => imageMedia(testImage([1])) };
    await cache.warm(input);
    const date = entry()!.fetchedAt;
    const error = new MusicSourceHttpError(429, 120000);
    await expect(cache.refresh({ ...input, load: async () => { throw error; } })).rejects.toBe(error);
    expect(entry()!.fetchedAt).toEqual(date);
    expect(entry()!.imageLastResult).toBe('error');
    expect(entry()!.nextRefreshAt!.valueOf() - Date.now()).toBeGreaterThan(119000);
    expect(await body(await cache.get(input))).toEqual(testImage([1]));
  });

  it('bounds a stalled response body and cancels it without storing partial bytes', async () => {
    const { cache, entry } = await statefulCache({ fillTimeoutMs: 20 });
    const cancel = vi.fn();
    const load = async () => ({ ...imageMedia(testImage([1])), body: new ReadableStream<Uint8Array>({ cancel }) });
    await expect(cache.warm({ sourceId: 'source', remoteId: 'cover', size: 320, load })).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(cancel).toHaveBeenCalledOnce();
    expect(entry()).toBeNull();
  });

  it('rejects a late publication from another cache instance', async () => {
    const { cache, repository, store, entry } = await statefulCache();
    const other = new ImageCacheService(repository, store, 1, { random: () => 0 });
    const input = { sourceId: 'source', remoteId: 'cover', size: 320, load: async () => imageMedia(testImage([1])) };
    await cache.warm(input);
    let finish!: (media: SourceMedia) => void;
    const late = cache.refresh({ ...input, load: () => new Promise(resolve => { finish = resolve; }) });
    await vi.waitFor(() => expect(finish).toBeDefined());
    await other.refresh({ ...input, load: async () => imageMedia(testImage([3])) });
    const revision = entry()!.revision;
    finish(imageMedia(testImage([2]))); await late;
    expect(entry()!.revision).toBe(revision);
    expect(await body(await cache.get(input))).toEqual(testImage([3]));
  });
});

describe('recoverable image versions', () => {
  const input = { sourceId: 'source', remoteId: 'cover', size: 320, load: async () => imageMedia(testImage([1])) };

  it('respects error backoff when a classified placeholder has no prior photo', async () => {
    const { cache, entry } = await statefulCache();
    await cache.warm({ ...input, load: async () => imageMedia(placeholderBytes) });
    await expect(cache.refresh({ ...input, load: async () => { throw new MusicSourceHttpError(429, 120000); } })).rejects.toThrow();
    const load = vi.fn(input.load);
    await cache.warm({ ...input, load });
    expect(load).not.toHaveBeenCalled();
    expect(entry()!.imageLastResult).toBe('error');
  });

  it.each([128, 320, 640])('retains photos for both real static placeholders at size %i', async size => {
    const { cache, entry } = await statefulCache();
    const request = { ...input, size };
    await cache.warm(request);
    for (const placeholder of [placeholderBytes, albumPlaceholderBytes]) {
      expect(KNOWN_IMAGE_PLACEHOLDERS.has(createHash('sha256').update(placeholder).digest('hex'))).toBe(true);
      await cache.refresh({ ...request, load: async () => imageMedia(placeholder) });
      expect(await body(await cache.get(request))).toEqual(testImage([1]));
      expect(entry()!.previousImage).toBeUndefined();
    }
  });

  it('keeps just one previous version, without rotating or prolonging it on identical bytes', async () => {
    const { cache, entry } = await statefulCache();
    await cache.warm(input);
    const first = entry()!.contentHash;
    const second = { ...input, load: async () => imageMedia(testImage([2])) };
    await cache.refresh(second);
    expect(entry()!.previousImage!.contentHash).toBe(first);
    const expiry = entry()!.previousImageExpiresAt;
    await cache.refresh(second);
    expect(entry()!.previousImageExpiresAt).toEqual(expiry);
    const secondHash = entry()!.contentHash;
    await cache.refresh({ ...input, load: async () => imageMedia(testImage([3])) });
    expect(entry()!.previousImage!.contentHash).toBe(secondHash);
  });

  it('recovers a missing current object after recreating the service', async () => {
    const { cache, repository, store, entry } = await statefulCache();
    await cache.warm(input);
    await cache.refresh({ ...input, load: async () => imageMedia(testImage([2])) });
    await store.remove(entry()!.relativePath);
    const restarted = new ImageCacheService(repository, store);
    expect(await body(await restarted.get(input))).toEqual(testImage([1]));
    expect(entry()!.previousImage).toBeNull();
    // A missing file does not blacklist its otherwise valid hash.
    expect(entry()!.rejectedImageHash).toBeUndefined();
  });

  it('automatically recovers a current image reclassified as a known placeholder', async () => {
    const { cache, store, entry, repository } = await statefulCache();
    await cache.warm(input);
    await cache.refresh({ ...input, load: async () => imageMedia(testImage([2])) });
    const poisoned = await store.put(placeholderBytes);
    Object.assign(entry()!, { relativePath: poisoned.relativePath, contentHash: poisoned.hash,
      contentType: 'image/webp', byteLength: poisoned.byteLength, imageLastResult: 'image' });
    const restarted = new ImageCacheService(repository, store);
    expect(await body(await restarted.get(input))).toEqual(testImage([1]));
    expect(entry()!.rejectedImageHash).toBe(poisoned.hash);
  });

  it('accepts small identical legitimate photos on different keys', async () => {
    const { cache, repository, store } = await statefulCache();
    await cache.warm(input);
    expect(KNOWN_IMAGE_PLACEHOLDERS.has(createHash('sha256').update(testImage([1])).digest('hex'))).toBe(false);
    await new ImageCacheService(repository, store).refresh({ ...input, remoteId: 'other' });
    expect(await body(await cache.get(input))).toEqual(testImage([1]));
  });

  it('rejects an excessive pixel count without replacing the current image', async () => {
    const { cache } = await statefulCache();
    await cache.warm(input);
    const large = await sharp({ create: { width: 4097, height: 4096, channels: 3, background: 'red' } }).png().toBuffer();
    await expect(cache.refresh({ ...input, load: async () => imageMedia(large) })).rejects.toThrow('decoded');
    expect(await body(await cache.get(input))).toEqual(testImage([1]));
  });

  it('only rolls back the inspected hash and blocks immediate reacceptance', async () => {
    const { cache, entry } = await statefulCache();
    await cache.warm(input);
    const second = { ...input, load: async () => imageMedia(testImage([2])) };
    await cache.refresh(second);
    const hash = entry()!.contentHash;
    expect(await cache.restorePrevious(input, 'outdated')).toBe(false);
    expect(await cache.restorePrevious(input, hash)).toBe(true);
    await expect(cache.refresh(second)).rejects.toThrow('temporarily rejected');
    expect(await body(await cache.get(input))).toEqual(testImage([1]));
  });

  it('does not restore expired, missing or newly recognized placeholder previous files', async () => {
    const { cache, store, entry } = await statefulCache();
    await cache.warm(input);
    await cache.refresh({ ...input, load: async () => imageMedia(testImage([2])) });
    entry()!.previousImageExpiresAt = new Date(0);
    expect(await cache.restorePrevious(input, entry()!.contentHash)).toBe(false);
    entry()!.previousImageExpiresAt = new Date(Date.now() + 10000);
    await store.remove(entry()!.previousImage!.relativePath);
    expect(await cache.restorePrevious(input, entry()!.contentHash)).toBe(false);
    entry()!.previousImage!.contentHash = createHash('sha256').update(placeholderBytes).digest('hex');
    expect(await cache.restorePrevious(input, entry()!.contentHash)).toBe(false);
  });

  it.each(['<html>Bad gateway</html>', '<?xml version="1.0"?><error/>'])('rejects non-image bytes with image MIME: %s', async text => {
    const { cache, entry } = await statefulCache();
    await cache.warm(input);
    const before = entry()!;
    await expect(cache.refresh({ ...input, load: async () => imageMedia(new TextEncoder().encode(text)) })).rejects.toThrow();
    expect(entry()!.contentHash).toBe(before.contentHash);
    expect(entry()!.fetchedAt).toEqual(before.fetchedAt);
    expect(entry()!.previousImage).toBeUndefined();
  });

  it('rejects a truncated image even when the header is recognizable', async () => {
    const { cache, entry } = await statefulCache();
    await cache.warm(input);
    const jpeg = await sharp({ create: { width: 100, height: 100, channels: 3, background: 'red' } }).jpeg().toBuffer();
    await expect(cache.refresh({ ...input, load: async () => imageMedia(jpeg.subarray(0, jpeg.length - 40)) })).rejects.toThrow();
    expect(await body(await cache.get(input))).toEqual(testImage([1]));
    expect(entry()!.imageLastResult).toBe('error');
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
      entry = { ...entry, relativePath: input.relativePath, contentHash: input.objectHash, contentType: input.contentType,
        byteLength: input.byteLength, fetchedAt: new Date(), revision: String(Number(entry?.revision ?? 0) + 1) };
    }),
    touch: vi.fn(async () => undefined),
    recordImageAttempt: vi.fn(async (_key: string, result: CachedObjectEntry['imageLastResult'], attempts: number, delay: number) => {
      if (entry) entry = { ...entry, imageLastResult: result, imageAttempts: attempts,
        nextRefreshAt: new Date(Date.now() + delay), revision: String(Number(entry.revision) + 1) };
    }),
  } as unknown as CacheRepository;
  repository.retainPreviousImage = async (_key, previous) => {
    if (entry) entry = { ...entry, previousImage: { ...previous, fetchedAt: previous.fetchedAt?.toISOString() },
      previousImageExpiresAt: new Date(Date.now() + 30 * 86400000) };
  };
  repository.restorePreviousImage = async (_key, prior, reject) => {
    if (entry) entry = { ...entry, ...prior, fetchedAt: prior.fetchedAt ? new Date(prior.fetchedAt) : entry.fetchedAt,
      previousImage: null, previousImageExpiresAt: null, revision: String(Number(entry.revision) + 1),
      nextRefreshAt: new Date(Date.now() + 30000), rejectedImageHash: reject ?? entry.rejectedImageHash,
      rejectedImageUntil: reject ? new Date(Date.now() + 30 * 86400000) : entry.rejectedImageUntil };
  };
  repository.publishImage = async (_key, expected, operation) => {
    if ((entry?.revision ?? null) !== expected) return { published: false };
    return { published: true, value: await operation(repository) };
  };
  const cache = new ImageCacheService(repository, store, 2, { random: () => 0, ...options });
  return { cache, repository, store, entry: () => entry,
    expire: () => { if (entry) entry.nextRefreshAt = new Date(0); } };
}

function withLifecycle(repository: CacheRepository): CacheRepository {
  repository.retainPreviousImage = vi.fn(async () => undefined);
  repository.withObjectMutation = async operation => operation(repository);
  repository.publishImage = async (_key, _revision, operation) => ({ published: true, value: await operation(repository) });
  repository.recordImageAttempt = vi.fn(async () => undefined);
  return repository;
}

function imageMedia(bytes: Uint8Array): SourceMedia {
  return {
    status: 200,
    body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }),
    contentType: 'image/png', contentLength: String(bytes.byteLength),
    contentRange: null, acceptRanges: null,
  };
}

async function body(media: SourceMedia): Promise<Uint8Array> {
  return new Uint8Array(await new Response(media.body).arrayBuffer());
}
