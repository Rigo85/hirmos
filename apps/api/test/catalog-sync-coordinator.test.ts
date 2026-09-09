import { describe, expect, it, vi } from 'vitest';
import { CatalogSyncCoordinator } from '../src/cache/catalog-sync-coordinator.js';

describe('CatalogSyncCoordinator', () => {
  it('coalesces concurrent triggers and runs follow-up work once', async () => {
    const pending = deferred<{ artists: number; albums: number; tracks: number }>();
    const syncCatalog = vi.fn(() => pending.promise);
    const afterSync = vi.fn(async () => undefined);
    const times = [
      new Date('2026-09-08T10:00:00.000Z'),
      new Date('2026-09-08T10:00:05.000Z'),
    ];
    const coordinator = new CatalogSyncCoordinator(
      { syncCatalog },
      () => times.shift() ?? new Date('2026-09-08T10:00:05.000Z'),
    );
    coordinator.setAfterSync(afterSync);

    const first = coordinator.trigger();
    const second = coordinator.trigger();

    expect(first.started).toBe(true);
    expect(second.started).toBe(false);
    expect(second.completion).toBe(first.completion);
    expect(syncCatalog).toHaveBeenCalledTimes(1);
    expect(coordinator.status()).toEqual({
      status: 'running', startedAt: '2026-09-08T10:00:00.000Z',
      completedAt: null, counts: null,
    });

    pending.resolve({ artists: 82, albums: 590, tracks: 6888 });
    await first.completion;

    expect(afterSync).toHaveBeenCalledTimes(1);
    expect(coordinator.status()).toEqual({
      status: 'succeeded', startedAt: '2026-09-08T10:00:00.000Z',
      completedAt: '2026-09-08T10:00:05.000Z',
      counts: { artists: 82, albums: 590, tracks: 6888 },
    });
  });

  it('publishes a failed state without exposing the upstream error', async () => {
    const coordinator = new CatalogSyncCoordinator({
      syncCatalog: vi.fn(async () => { throw new Error('private upstream detail'); }),
    }, () => new Date('2026-09-08T10:00:00.000Z'));

    await expect(coordinator.trigger().completion).rejects.toThrow('private upstream detail');

    expect(coordinator.status()).toEqual({
      status: 'failed', startedAt: '2026-09-08T10:00:00.000Z',
      completedAt: '2026-09-08T10:00:00.000Z', counts: null,
    });
  });
});

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}
