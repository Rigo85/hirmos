import { describe, expect, it, vi } from 'vitest';
import { NavidromeAdapter } from '../src/music-source/navidrome-adapter.js';

describe('NavidromeAdapter', () => {
  it('discovers extensions without exposing the password in requests', async () => {
    const urls: URL[] = [];
    const fetchImplementation = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      urls.push(url);
      const extensions = url.pathname.includes('getOpenSubsonicExtensions');
      return Response.json({
        'subsonic-response': {
          status: 'ok',
          version: '1.16.1',
          type: 'navidrome',
          serverVersion: '0.60.3',
          ...(extensions
            ? { openSubsonicExtensions: [{ name: 'songLyrics', versions: [1] }] }
            : {}),
        },
      });
    });
    const adapter = new NavidromeAdapter({
      baseUrl: new URL('https://music.example'),
      username: 'service',
      password: 'source-secret',
      fetchImplementation: fetchImplementation as typeof fetch,
    });

    const result = await adapter.probe();
    expect(result.serverVersion).toBe('0.60.3');
    expect(result.capabilities).toContain('structuredLyrics');
    expect(urls).toHaveLength(2);
    for (const url of urls) {
      expect(url.searchParams.get('u')).toBe('service');
      expect(url.searchParams.has('t')).toBe(true);
      expect(url.searchParams.has('s')).toBe(true);
      expect(url.href).not.toContain('source-secret');
      expect(url.searchParams.has('p')).toBe(false);
    }
  });

  it('maps search3 songs to neutral track records', async () => {
    const fetchImplementation = vi.fn(async () => Response.json({
      'subsonic-response': {
        status: 'ok',
        version: '1.16.1',
        searchResult3: {
          song: [{
            id: 'remote-track', title: 'Canción', artist: 'Artista', album: 'Álbum',
            duration: 215, coverArt: 'cover-id', year: 2020, starred: '2026-01-01T00:00:00Z',
          }],
        },
      },
    }));
    const adapter = new NavidromeAdapter({
      baseUrl: new URL('https://music.example'),
      username: 'service',
      password: 'secret',
      fetchImplementation: fetchImplementation as typeof fetch,
    });

    const result = await adapter.search('canción');
    expect(result.tracks).toEqual([{
      id: 'remote-track', title: 'Canción', artist: 'Artista', album: 'Álbum',
      artistId: null, albumId: null,
      durationMs: 215000, coverArtId: 'cover-id', year: 2020, favorite: true,
    }]);
    expect(result.artists).toEqual([]);
    expect(result.albums).toEqual([]);
    expect(result.nextCursor).toBeNull();
  });

  it('forwards byte ranges for audio without putting credentials in headers', async () => {
    let request: { url: URL; headers: Headers } | null = null;
    const fetchImplementation = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      request = { url: new URL(String(input)), headers: new Headers(init?.headers) };
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 206,
        headers: {
          'content-type': 'audio/flac',
          'content-range': 'bytes 0-2/100',
          'accept-ranges': 'bytes',
        },
      });
    });
    const adapter = new NavidromeAdapter({
      baseUrl: new URL('https://music.example'),
      username: 'service',
      password: 'secret',
      fetchImplementation: fetchImplementation as typeof fetch,
    });
    const media = await adapter.getStream('track-id', 'bytes=0-2');
    expect(media.status).toBe(206);
    expect(request).not.toBeNull();
    expect(request!.headers.get('range')).toBe('bytes=0-2');
    expect(request!.url.pathname).toBe('/rest/stream.view');
    expect(request!.url.searchParams.get('id')).toBe('track-id');
    expect(request!.url.href).not.toContain('secret');
  });

  it('maps synchronized OpenSubsonic lyrics', async () => {
    const fetchImplementation = vi.fn(async () => Response.json({
      'subsonic-response': {
        status: 'ok', version: '1.16.1',
        lyricsList: { structuredLyrics: [{
          displayArtist: 'Artista', displayTitle: 'Canción', lang: 'es', synced: true,
          line: [{ start: 1200, value: 'Primera línea' }],
        }] },
      },
    }));
    const adapter = new NavidromeAdapter({
      baseUrl: new URL('https://music.example'), username: 'service', password: 'secret',
      fetchImplementation: fetchImplementation as typeof fetch,
    });
    await expect(adapter.getLyrics('track-id')).resolves.toEqual([{
      displayArtist: 'Artista', displayTitle: 'Canción', language: 'es', synced: true,
      lines: [{ startMs: 1200, text: 'Primera línea' }],
    }]);
  });

  it('enriches an artist with safe biography, related artists and public top songs', async () => {
    const fetchImplementation = vi.fn(async (input: URL | RequestInfo) => {
      const endpoint = new URL(String(input)).pathname;
      if (endpoint.includes('getArtistInfo2')) {
        return Response.json({ 'subsonic-response': {
          status: 'ok', version: '1.16.1', artistInfo2: {
            biography: 'Una banda &amp; su historia. <a href="https://last.fm">Read more on Last.fm</a>',
            lastFmUrl: 'https://www.last.fm/music/Example',
            similarArtist: [{ id: 'similar-id', name: 'Banda similar', coverArt: 'similar-cover' }],
          },
        } });
      }
      if (endpoint.includes('getTopSongs')) {
        return Response.json({ 'subsonic-response': {
          status: 'ok', version: '1.16.1', topSongs: { song: [{
            id: 'top-track', title: 'La popular', artist: 'Banda', album: 'Disco', duration: 180,
          }] },
        } });
      }
      return Response.json({ 'subsonic-response': {
        status: 'ok', version: '1.16.1', artist: {
          id: 'artist-id', name: 'Banda', albumCount: 1,
          album: [{ id: 'album-id', name: 'Disco', artist: 'Banda', songCount: 1 }],
        },
      } });
    });
    const adapter = new NavidromeAdapter({
      baseUrl: new URL('https://music.example'), username: 'service', password: 'secret',
      fetchImplementation: fetchImplementation as typeof fetch,
    });

    const artist = await adapter.getArtist('artist-id');
    expect(artist.biography).toBe('Una banda & su historia.');
    expect(artist.externalUrl).toBe('https://www.last.fm/music/Example');
    expect(artist.similarArtists[0]).toMatchObject({ id: 'similar-id', name: 'Banda similar' });
    expect(artist.topTracks[0]).toMatchObject({ id: 'top-track', title: 'La popular', durationMs: 180_000 });
  });
});
