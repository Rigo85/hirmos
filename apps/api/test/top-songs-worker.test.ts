import { describe, expect, it, vi } from 'vitest';
import { TopSongsWorker } from '../src/cache/top-songs-worker.js';

describe('TopSongsWorker', () => {
  it('preserves stale data and reschedules a failed provider request', async () => {
    vi.useFakeTimers();
    const repository = {
      enqueueDue: vi.fn(async () => 0),
      claim: vi.fn()
        .mockResolvedValueOnce({ id: 7, sourceId: 'source', remoteArtistId: 'artist', attempts: 1 })
        .mockResolvedValue(null),
      recordTemporaryError: vi.fn(async () => undefined),
      fail: vi.fn(async () => undefined),
      complete: vi.fn(async () => undefined),
      stats: vi.fn(async () => ({})),
    };
    const service = { refreshArtistTopSongs: vi.fn(async () => { throw new Error('timeout'); }) };
    const worker = new TopSongsWorker(repository as never, service as never, {
      info: vi.fn(), warn: vi.fn(),
    });

    worker.start();
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(1);

    expect(repository.recordTemporaryError).toHaveBeenCalledWith('source', 'artist');
    expect(repository.fail).toHaveBeenCalledWith(
      7, expect.stringMatching(/^top-songs-/), 'Error', expect.any(Number),
    );
    expect(repository.complete).not.toHaveBeenCalled();
    await worker.stop();
    vi.useRealTimers();
  });
});
