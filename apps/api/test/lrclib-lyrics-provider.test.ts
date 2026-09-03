import { describe, expect, it, vi } from 'vitest';
import { LrclibLyricsProvider, parseLrc } from '../src/lyrics/lrclib-lyrics-provider.js';

const track = {
  id: 'one', title: 'Canción', artist: 'Artista', artistId: null,
  album: 'Álbum', albumId: null, durationMs: 215_000, coverArtId: null,
  year: null, favorite: false,
};

describe('LrclibLyricsProvider', () => {
  it('sends complete metadata and maps synchronized lyrics', async () => {
    let requested: URL | null = null;
    const provider = new LrclibLyricsProvider(vi.fn(async (input) => {
      requested = new URL(String(input));
      return Response.json({
        id: 7, trackName: 'Canción', artistName: 'Artista',
        syncedLyrics: '[00:01.25]Primera\n[01:02.003]Segunda', plainLyrics: null,
      });
    }) as typeof fetch);
    const result = await provider.find(track);
    expect(requested!.searchParams.get('duration')).toBe('215');
    expect(requested!.searchParams.get('album_name')).toBe('Álbum');
    expect(result?.document.synced).toBe(true);
    expect(result?.document.lines).toEqual([
      { startMs: 1_250, text: 'Primera' },
      { startMs: 62_003, text: 'Segunda' },
    ]);
  });

  it('treats a 404 as a normal miss', async () => {
    const provider = new LrclibLyricsProvider(vi.fn(async () => new Response(null, { status: 404 })) as typeof fetch);
    await expect(provider.find(track)).resolves.toBeNull();
  });
});

describe('parseLrc', () => {
  it('supports several timestamps on the same line', () => {
    expect(parseLrc('[00:01.0][00:02.00]Eco')).toEqual([
      { startMs: 1_000, text: 'Eco' }, { startMs: 2_000, text: 'Eco' },
    ]);
  });
});
