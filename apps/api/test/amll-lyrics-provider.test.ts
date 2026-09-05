import { describe, expect, it, vi } from 'vitest';
import { AmllLyricsProvider, parseAmllTtml, parseTtmlTime } from '../src/lyrics/amll-lyrics-provider.js';

const track = {
  id: 'one', title: 'Show Me How to Live', artist: 'Audioslave', artistId: null,
  album: 'Audioslave', albumId: null, durationMs: 215_000, coverArtId: null,
  year: 2002, favorite: false,
};

const ttml = `<?xml version="1.0" encoding="UTF-8"?>
<tt xmlns="http://www.w3.org/ns/ttml"
    xmlns:ttm="http://www.w3.org/ns/ttml#metadata" xml:lang="en">
  <body dur="3:35.000"><div>
    <p begin="1.000s" end="2.500s"><span begin="1.000s" end="1.500s">Show</span> <span begin="1.500s" end="2.500s">me</span><span ttm:role="x-translation">Muéstrame</span></p>
  </div></body>
</tt>`;

describe('AmllLyricsProvider', () => {
  it('selects a matching result and maps word-level TTML', async () => {
    const requested: URL[] = [];
    const provider = new AmllLyricsProvider(vi.fn(async (input) => {
      const url = new URL(String(input));
      requested.push(url);
      if (url.pathname.endsWith('/search')) {
        return Response.json({ status: 200, data: { items: [{
          id: 7,
          musicNames: ['Show Me How to Live'],
          artistNames: ['Audioslave'],
          albumNames: ['Audioslave'],
        }] } });
      }
      return Response.json({ status: 200, data: {
        id: 7, musicNames: [], artistNames: [], albumNames: [], lyrics: ttml,
      } });
    }) as typeof fetch);

    const result = await provider.find(track);

    expect(requested[0].searchParams.get('musicName')).toBe(track.title);
    expect(requested[0].searchParams.get('artistName')).toBe(track.artist);
    expect(requested[1].searchParams.get('id')).toBe('7');
    expect(result).toMatchObject({
      providerItemId: '7',
      document: {
        language: 'en', synced: true,
        lines: [{
          startMs: 1_000, endMs: 2_500, text: 'Show me',
          words: [
            { startMs: 1_000, endMs: 1_500, text: 'Show ' },
            { startMs: 1_500, endMs: 2_500, text: 'me' },
          ],
        }],
      },
    });
  });

  it('rejects a result whose duration differs materially', async () => {
    const wrongDuration = ttml.replace('3:35.000', '2:00.000');
    const provider = new AmllLyricsProvider(vi.fn(async (input) => {
      const url = new URL(String(input));
      return url.pathname.endsWith('/search')
        ? Response.json({ status: 200, data: { items: [{
          id: 7, musicNames: [track.title], artistNames: [track.artist], albumNames: [track.album],
        }] } })
        : Response.json({ status: 200, data: {
          id: 7, musicNames: [], artistNames: [], albumNames: [], lyrics: wrongDuration,
        } });
    }) as typeof fetch);

    await expect(provider.find(track)).resolves.toBeNull();
  });
});

describe('AMLL TTML parsing', () => {
  it('parses second, millisecond and clock timestamps', () => {
    expect(parseTtmlTime('1.25s')).toBe(1_250);
    expect(parseTtmlTime('1250ms')).toBe(1_250);
    expect(parseTtmlTime('01:02.003')).toBe(62_003);
  });

  it('ignores translations while preserving spaces between timed words', () => {
    expect(parseAmllTtml(ttml).lines[0]).toEqual({
      startMs: 1_000,
      endMs: 2_500,
      text: 'Show me',
      words: [
        { startMs: 1_000, endMs: 1_500, text: 'Show ' },
        { startMs: 1_500, endMs: 2_500, text: 'me' },
      ],
    });
  });
});
