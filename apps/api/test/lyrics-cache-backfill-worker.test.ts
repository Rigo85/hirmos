import { describe, expect, it, vi } from 'vitest';
import { LyricsCacheBackfillWorker } from '../src/cache/lyrics-cache-backfill-worker.js';

describe('LyricsCacheBackfillWorker', () => {
  it('copies an existing normalized lyric without downloading it again', async () => {
    let first = true;
    const repository = {
      withoutRawObject: vi.fn(async () => {
        if (!first) return [];
        first = false;
        return [{
          sourceId: 'source-a', remoteTrackId: 'track-a', provider: 'opensubsonic',
          fingerprint: 'fingerprint-a',
          document: {
            displayArtist: 'Artist', displayTitle: 'Song', language: null, synced: false,
            lines: [{ startMs: null, text: 'Existing line' }],
          },
        }];
      }),
      attachRawObject: vi.fn(async () => undefined),
    };
    const cache = {
      put: vi.fn(async () => ({ key: 'object-key', parserVersion: 'normalized-v1' })),
    };
    const logger = { info: vi.fn(), warn: vi.fn() };
    const worker = new LyricsCacheBackfillWorker(repository as never, cache as never, logger as never);

    await worker.run();

    expect(cache.put).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'opensubsonic', remoteTrackId: 'track-a',
    }));
    expect(repository.attachRawObject).toHaveBeenCalledWith(expect.objectContaining({
      rawObjectKey: 'object-key', parserVersion: 'normalized-v1',
    }));
    expect(logger.info).toHaveBeenCalledWith({ migrated: 1 }, expect.any(String));
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
