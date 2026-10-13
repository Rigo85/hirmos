import {afterEach,expect,it,vi} from 'vitest';
import type {FastifyInstance} from 'fastify';
import {buildApp} from '../src/app.js';
import {loadConfig} from '../src/config.js';
import type {AuthService} from '../src/auth/auth-service.js';
import type {MusicSourceService} from '../src/music-source/music-source-service.js';
let app:FastifyInstance;
afterEach(async()=>{await app?.close();});
const path='/api/library/favorites/download-selection';
async function setup(){
  const favoriteSelectionReferences=vi.fn(async(_owner:string)=>['one','two']);
  app=await buildApp({config:loadConfig({NODE_ENV:'test'}),musicSourceService:{favoriteSelectionReferences} as unknown as MusicSourceService,
    authService:{authenticate:async(token:string)=>token==='valid'?{id:'session',response:{user:{id:'owner',email:'a@example.test',displayName:'A',role:'user'},expiresAt:new Date(Date.now()+60000).toISOString()}}:null} as unknown as AuthService});
  return favoriteSelectionReferences;
}
const headers={cookie:'hirmos_session=valid','x-hirmos-account-id':'owner'};
it('uses session identity, checks owner assertion and never serves public cached membership',async()=>{
  const query=await setup();expect((await app.inject(path)).statusCode).toBe(401);
  expect((await app.inject({url:path,headers:{...headers,'x-hirmos-account-id':'other'}})).statusCode).toBe(409);
  expect(query).not.toHaveBeenCalled();
  const result=await app.inject({url:path+'?userId=other&limit=1',headers});
  expect(result.json()).toEqual({references:['one','two']});expect(result.headers['cache-control']).toBe('private, no-store');
  expect(result.headers['x-hirmos-account-id']).toBe('owner');expect(query).toHaveBeenCalledExactlyOnceWith('owner');
});
it('supports empty/5000 snapshots and rejects overflow without a truncated selection',async()=>{
  const query=await setup();query.mockResolvedValueOnce([]);
  expect((await app.inject({url:path,headers})).json()).toEqual({references:[]});
  query.mockResolvedValueOnce(Array.from({length:5000},(_,i)=>String(i)));
  expect((await app.inject({url:path,headers})).json().references).toHaveLength(5000);
  query.mockResolvedValueOnce(Array(5001).fill('reference'));
  const overflow=await app.inject({url:path,headers});expect(overflow.statusCode).toBe(413);
  expect(overflow.json().code).toBe('FAVORITES_LIMIT');expect(overflow.json().references).toBeUndefined();
});
