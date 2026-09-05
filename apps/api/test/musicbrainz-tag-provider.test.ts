import { afterEach, describe, expect, it, vi } from 'vitest';
import { MusicBrainzTagProvider } from '../src/metadata/musicbrainz-tag-provider.js';

describe('MusicBrainzTagProvider', () => {
  afterEach(() => vi.useRealTimers());

  it('serializes concurrent requests at the public API cadence', async () => {
    vi.useFakeTimers();
    const calledAt: number[] = [];
    const fetchImplementation = vi.fn(async () => {
      calledAt.push(Date.now());
      return new Response(JSON.stringify({ genres: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const provider = new MusicBrainzTagProvider(fetchImplementation);

    const first = provider.find({ artistName: 'One', musicBrainzId: 'mbid-one' });
    const second = provider.find({ artistName: 'Two', musicBrainzId: 'mbid-two' });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchImplementation).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_099);
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await Promise.all([first, second]);

    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    expect(calledAt[1]! - calledAt[0]!).toBeGreaterThanOrEqual(1_100);
  });
});
