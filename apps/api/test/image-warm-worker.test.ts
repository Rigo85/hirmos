import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ImageWarmRepository } from '../src/cache/image-warm-repository.js';
import { ImageWarmWorker } from '../src/cache/image-warm-worker.js';
import type { MusicSourceService } from '../src/music-source/music-source-service.js';
import { MusicSourceHttpError } from '../src/music-source/navidrome-adapter.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('ImageWarmWorker', () => {
  it('persists the provider retry deadline instead of retrying early', async () => {
    vi.useFakeTimers();
    const repository = {
      enqueueCatalogImages: vi.fn(async () => 0),
      claim: vi.fn().mockResolvedValueOnce({ id: 8, sourceId: 's', remoteId: 'c', size: 320, attempts: 1 }).mockResolvedValue(null),
      complete: vi.fn(), fail: vi.fn(async () => undefined),
    } as unknown as ImageWarmRepository;
    const service = { warmCover: vi.fn().mockRejectedValue(new MusicSourceHttpError(429, 120_000)) } as unknown as MusicSourceService;
    const worker = new ImageWarmWorker(repository, service, { info: vi.fn(), warn: vi.fn() });
    worker.start();
    await vi.advanceTimersByTimeAsync(20_500);
    expect(repository.fail).toHaveBeenCalledWith(8, expect.any(String), 'HTTP_429', 120_000);
    expect(repository.complete).not.toHaveBeenCalled();
    await worker.stop();
  });
  it('persists completion after warming one queued image', async () => {
    vi.useFakeTimers();
    const repository = {
      enqueueCatalogImages: vi.fn(async () => 1),
      stats: vi.fn(async () => ({ pending: 1, running: 0, completed: 0, failed: 0 })),
      claim: vi.fn()
        .mockResolvedValueOnce({
          id: 7, sourceId: 'source-a', remoteId: 'cover-a', size: 320, attempts: 1,
        })
        .mockResolvedValue(null),
      complete: vi.fn(async () => undefined),
      fail: vi.fn(async () => undefined),
    } as unknown as ImageWarmRepository;
    const service = {
      warmCover: vi.fn(async () => undefined),
    } as unknown as MusicSourceService;
    const logger = { info: vi.fn(), warn: vi.fn() };
    const worker = new ImageWarmWorker(repository, service, logger);

    worker.start();
    await vi.advanceTimersByTimeAsync(20_500);

    expect(service.warmCover).toHaveBeenCalledWith('source-a', 'cover-a', 320);
    expect(repository.complete).toHaveBeenCalledWith(7, expect.stringMatching(/^image-warm-/));
    expect(repository.fail).not.toHaveBeenCalled();
    await worker.stop();
  });
});
