import { afterEach,expect,it,vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { AuthService } from '../src/auth/auth-service.js';
import type { MusicSourceService } from '../src/music-source/music-source-service.js';

let app:FastifyInstance;
afterEach(async()=>{await app?.close();});
it('binds auxiliary bytes to the authenticated account and does not publicly cache personalized lyrics',async()=>{
  const lyrics=vi.fn(async()=>({availability:'not_found',lyrics:[],adjustmentMs:0}));
  const cover=vi.fn(async()=>({status:200,body:new Response(new Uint8Array([1,2,3])).body!,contentType:'image/png',contentLength:'3'}));
  app=await buildApp({config:loadConfig({NODE_ENV:'test'}),
    musicSourceService:{lyrics,cover} as unknown as MusicSourceService,
    authService:{authenticate:async(token:string)=>token==='synthetic'?{id:'session',response:{user:{id:'owner',role:'user',email:'test@example.test',displayName:'Test'},expiresAt:new Date(Date.now()+60000).toISOString()}}:null} as unknown as AuthService});
  for(const url of ['/api/music/tracks/reference/lyrics','/api/music/covers/reference?size=320']){
    const denied=await app.inject(url);expect(denied.statusCode).toBe(401);expect(denied.headers['x-hirmos-account-id']).toBeUndefined();
    const result=await app.inject({url,headers:{cookie:'hirmos_session=synthetic'}});
    expect(result.statusCode).toBe(200);expect(result.headers['x-hirmos-account-id']).toBe('owner');
    if(url.includes('lyrics'))expect(result.headers['cache-control']).toBe('private, no-store');
  }
  expect(lyrics).toHaveBeenCalledExactlyOnceWith('reference','owner',expect.any(AbortSignal));expect(cover).toHaveBeenCalledOnce();
});
