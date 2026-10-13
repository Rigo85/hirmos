import { afterEach, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { AuthService } from '../src/auth/auth-service.js';
import type { MusicSourceService } from '../src/music-source/music-source-service.js';
import type { SourceMedia } from '../src/music-source/music-source-adapter.js';
import { encodeTrackReference } from '../src/music-source/track-reference.js';
import { SourceHttpError } from '../src/music-source/source-http-error.js';

let app: FastifyInstance;
afterEach(async () => { await app?.close(); });
const reference = encodeTrackReference('11111111-1111-4111-8111-111111111111', 'track');
const url = `/api/music/tracks/${reference}/download`;
const headers = { cookie: 'hirmos_session=synthetic' };
function media(): SourceMedia { return { status:200, body:new Response(new Uint8Array([1,2,3])).body!,
  contentLength:'3', contentType:'audio/flac', contentRange:null, acceptRanges:'bytes', etag:'private-validator' }; }
async function setup(download = vi.fn(async (_ref: string, _signal?: AbortSignal) => media())) {
  const stream = vi.fn();
  app = await buildApp({ config:loadConfig({ NODE_ENV:'test' }),
    musicSourceService:{ download, stream } as unknown as MusicSourceService,
    authService:{ authenticate: async (token: string) => token === 'synthetic' ? {
      id:'session', response:{ user:{ id:'user',role:'user',email:'test@example.test',displayName:'Test' },
        expiresAt:new Date(Date.now()+60000).toISOString() },
    } : null } as unknown as AuthService });
  return { download, stream };
}
it('requires a live authenticated session and rejects malformed references before contacting provider', async () => {
  const { download } = await setup();
  expect((await app.inject(url)).statusCode).toBe(401);
  expect((await app.inject({url:'/api/music/tracks/invalid/download',headers})).statusCode).toBe(400);
  expect(download).not.toHaveBeenCalled();
});
it('downloads bytes unchanged with no-store, without using playback or leaking upstream validators', async () => {
  const { download, stream } = await setup();
  const response = await app.inject({url,headers});
  expect(response.statusCode).toBe(200);
  expect(response.rawPayload).toEqual(Buffer.from([1,2,3]));
  expect(response.headers['cache-control']).toBe('private, no-store');
  expect(response.headers['content-type']).toBe('audio/flac');
  expect(response.headers['content-length']).toBe('3');
  expect(response.headers['content-disposition']).toBe('attachment');
  expect(response.headers['x-hirmos-account-id']).toBe('user');
  expect(response.headers.etag).toBeUndefined();
  expect(response.headers['accept-ranges']).toBeUndefined();
  expect(download).toHaveBeenCalledWith(reference, expect.any(AbortSignal));
  expect(stream).not.toHaveBeenCalled();
});
it('rejects unsafe partial resumes instead of joining versions', async () => {
  const { download } = await setup();
  for (const range of [{range:'bytes=3-'},{'if-range':'"old-version"'}]) {
    const response = await app.inject({url,headers:{...headers,...range}});
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('DOWNLOAD_FULL_FILE_REQUIRED');
  }
  expect(download).not.toHaveBeenCalled();
});
it('preserves temporary provider waiting and distinguishes a missing track', async () => {
  const download = vi.fn().mockRejectedValueOnce(new SourceHttpError(429, 12000))
    .mockRejectedValueOnce(new SourceHttpError(404)).mockResolvedValue(media());
  await setup(download);
  const waiting = await app.inject({url,headers});
  expect(waiting.statusCode).toBe(503);
  expect(waiting.headers['retry-after']).toBe('12');
  expect((await app.inject({url,headers})).statusCode).toBe(404);
  expect((await app.inject({url,headers})).statusCode).toBe(200);
});
it('bounds simultaneous downloads and releases slots on completion', async () => {
  const release: Array<() => void> = [];
  const download = vi.fn(async () => {
    await new Promise<void>(resolve => release.push(resolve)); return media();
  });
  await setup(download);
  const first = app.inject({url,headers}); const second = app.inject({url,headers});
  await vi.waitFor(() => expect(release).toHaveLength(2));
  const busy = await app.inject({url,headers});
  expect(busy.statusCode).toBe(429); expect(busy.headers['retry-after']).toBe('5');
  release.splice(0).forEach(resolve => resolve());
  expect((await first).statusCode).toBe(200); expect((await second).statusCode).toBe(200);
  const third = app.inject({url,headers});
  await vi.waitFor(() => expect(release).toHaveLength(1)); release[0]!();
  expect((await third).statusCode).toBe(200);
});
it('never sends arbitrary provider errors or file paths to the client', async () => {
  await setup(vi.fn().mockRejectedValue(new Error('secret-token https://private.invalid/path')));
  const response = await app.inject({url,headers});
  expect(response.statusCode).toBe(502); expect(response.body).not.toMatch(/secret|private/);
});
