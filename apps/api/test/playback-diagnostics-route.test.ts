import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AuthService } from '../src/auth/auth-service.js';
import type { MusicSourceService } from '../src/music-source/music-source-service.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { SourceHttpError } from '../src/music-source/source-http-error.js';

describe('stream diagnostics route', () => {
  it('requires authentication, scopes a failure to its listener and never caches it publicly', async () => {
    const app=await buildApp({
      config:loadConfig({NODE_ENV:'test',PUBLIC_ORIGIN:'http://localhost:4200'}),logger:false,
      authService:{authenticate:async(token:string)=> ['one','two'].includes(token)
        ? {id:token,response:{user:{id:token,role:'user'}}} : null} as unknown as AuthService,
      musicSourceService:{stream:async()=>{throw new SourceHttpError(404);}} as unknown as MusicSourceService,
    });
    try {
      const id=randomUUID(), path=`/api/music/playback-failures/${id}`;
      expect((await app.inject({url:path})).statusCode).toBe(401);
      await app.inject({url:`/api/music/tracks/fixture/stream?playbackRequest=${id}`,headers:{cookie:'hirmos_session=one'}});
      const own=await app.inject({url:path,headers:{cookie:'hirmos_session=one'}});
      expect(own.json()).toEqual({code:'not_found'});
      expect(own.headers['cache-control']).toBe('private, no-store');
      expect((await app.inject({url:path,headers:{cookie:'hirmos_session=two'}})).json()).toBeNull();
    } finally {await app.close();}
  });
});
