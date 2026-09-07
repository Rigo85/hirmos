import { describe, expect, it, vi } from 'vitest';
import { LastFmTagProvider } from '../src/metadata/lastfm-tag-provider.js';

describe('LastFmTagProvider', () => {
  it('retries a transient response and maps the recovered tags', async () => {
    const fetchImplementation = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 429, headers: { 'retry-after': '0' } }))
      .mockResolvedValueOnce(Response.json({
        toptags: { tag: [{ name: 'Progressive Metal', count: '90' }] },
      }));
    const provider = new LastFmTagProvider('test-key', fetchImplementation as typeof fetch);

    await expect(provider.find({ artistName: 'Queensrÿche', musicBrainzId: null }))
      .resolves.toEqual([{ name: 'Progressive Metal', score: 90 }]);
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });
});
