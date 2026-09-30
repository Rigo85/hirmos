import { describe, expect, it } from 'vitest';
import type { AuthService } from '../src/auth/auth-service.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { MusicSourceService } from '../src/music-source/music-source-service.js';
import { SourceHttpError, SourceProtocolError, musicLookupFailure } from '../src/music-source/source-http-error.js';
import { encodeTrackReference } from '../src/music-source/track-reference.js';

const sourceId = '11111111-1111-4111-8111-111111111111';
const ref = (id: string) => encodeTrackReference(sourceId, id);

async function fixture(status: number, onFetch: () => void = () => undefined) {
  const service = new MusicSourceService(
    { current: async () => ({ id: sourceId, baseUrl: 'http://music.example.test', adapterType: 'navidrome' }) } as never,
    { decrypt: () => ({ username: 'fixture', password: 'fixture' }) } as never,
    { create: () => ({ getTrack: async () => { onFetch(); throw new SourceHttpError(status, 60_000); } }) } as never,
    undefined, undefined, [],
    { tracksByIds: async (_source: string, ids: string[]) => ids.includes('cached') ? [{
      id: 'cached', title: 'Cached', artist: 'Artist', artistId: 'artist', album: 'Album',
      albumId: 'album', durationMs: 180_000, coverArtId: null, year: null, genres: [],
    }] : [] } as never,
  );
  return buildApp({
    config: loadConfig({ NODE_ENV: 'test', PUBLIC_ORIGIN: 'http://localhost:4200' }), logger: false,
    authService: { authenticate: async () => ({ id: 'fixture', response: { user: { id: 'listener', role: 'user' } } }) } as unknown as AuthService,
    musicSourceService: service,
  });
}

describe('playback metadata errors across service and HTTP', () => {
  it('distinguishes OpenSubsonic absence, provider credentials, timeout and unknown failures', () => {
    expect(musicLookupFailure('track',new SourceProtocolError(70)).code).toBe('not_found');
    expect(musicLookupFailure('track',new SourceProtocolError(40)).code).toBe('service_unavailable');
    expect(musicLookupFailure('track',new DOMException('timeout','TimeoutError')).code).toBe('timeout');
    expect(musicLookupFailure('track',new Error('unknown')).code).toBe('unknown');
  });
  it('stops fetching more queue batches after a confirmed provider outage', async () => {
    let calls=0;
    const app=await fixture(503,()=>{calls++;});
    try {
      const references=Array.from({length:30},(_,i)=>ref(`missing-${i}`));
      const result=await app.inject({method:'POST',url:'/api/music/tracks/resolve',
        headers:{cookie:'hirmos_session=fixture'},payload:{references}});
      expect(result.json().failures).toHaveLength(30);
      expect(calls).toBe(6);
    } finally {await app.close();}
  });
  it('preserves a global outage and Retry-After instead of returning absence', async () => {
    const app = await fixture(503);
    try {
      const result = await app.inject({ url: `/api/music/tracks/${ref('missing')}`, headers: { cookie: 'hirmos_session=fixture' } });
      expect(result.statusCode).toBe(503);
      expect(result.json()).toMatchObject({ failure: { code: 'service_unavailable', retryAfterMs: 60_000 } });
      expect(result.headers['retry-after']).toBe('60');
    } finally { await app.close(); }
  });

  it('keeps cached tracks and explicit failures together in partial batches', async () => {
    const app = await fixture(503);
    try {
      const result = await app.inject({ method: 'POST', url: '/api/music/tracks/resolve',
        headers: { cookie: 'hirmos_session=fixture' }, payload: { references: [ref('cached'), ref('missing')] } });
      expect(result.statusCode).toBe(200);
      expect(result.json().tracks.map((track: { id: string }) => track.id)).toEqual([ref('cached')]);
      expect(result.json().failures).toEqual([{ reference: ref('missing'), code: 'service_unavailable', retryAfterMs: 60_000 }]);
    } finally { await app.close(); }
  });

  it('reports not_found only for a confirmed absent track', async () => {
    const app = await fixture(404);
    try {
      const result = await app.inject({ url: `/api/music/tracks/${ref('missing')}`, headers: { cookie: 'hirmos_session=fixture' } });
      expect(result.statusCode).toBe(404);
      expect(result.json()).toMatchObject({ failure: { code: 'not_found' } });
    } finally { await app.close(); }
  });
});
