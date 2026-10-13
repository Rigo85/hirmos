import {afterEach,expect,it,vi} from 'vitest';
import type {FastifyInstance} from 'fastify';
import {buildApp} from '../src/app.js';
import {loadConfig} from '../src/config.js';
import type {AuthService} from '../src/auth/auth-service.js';
import type {Database} from '../src/db/database.js';

let app:FastifyInstance;
afterEach(async()=>{await app?.close();});
async function setup(){
  const transaction=vi.fn().mockRejectedValue(new Error('private upstream details'));
  app=await buildApp({config:loadConfig({NODE_ENV:'test'}),database:{query:vi.fn(),transaction,close:vi.fn()} as unknown as Database,
    authService:{authenticate:async(token:string)=>token==='valid'?{id:'session',response:{user:{id:'user',email:'test@example.test',displayName:'Test',role:'user'},expiresAt:new Date(Date.now()+60000).toISOString()}}:null} as unknown as AuthService});
  return transaction;
}
const report={id:'11111111-1111-4111-8111-111111111111',executionId:'22222222-2222-4222-8222-222222222222',reference:'abc',
  startedAt:'2026-10-12T00:00:00.000Z',at:'2026-10-12T00:00:05.000Z',heardMs:5000};
const request=(headers={},reports:unknown=[report])=>app.inject({method:'POST',url:'/api/activity/offline',headers,payload:{reports}});
it('requires authentication and asserts the cookie account, never trusts a client owner',async()=>{
  const tx=await setup();expect((await request()).statusCode).toBe(401);
  expect((await request({cookie:'hirmos_session=valid','x-hirmos-account-id':'another'})).statusCode).toBe(409);
  expect(tx).not.toHaveBeenCalled();
});
it('rejects oversized batches, arbitrary ownership and impossible heard time',async()=>{
  const tx=await setup(),headers={cookie:'hirmos_session=valid','x-hirmos-account-id':'user'};
  for(const reports of [[],Array(51).fill(report),[{...report,userId:'another'}],[{...report,heardMs:60000}]])
    expect((await request(headers,reports)).statusCode).toBe(400);
  expect(tx).not.toHaveBeenCalled();
});
it('fails without ACK when the transaction fails and does not disclose details',async()=>{
  await setup();const response=await request({cookie:'hirmos_session=valid','x-hirmos-account-id':'user'});
  expect(response.statusCode).toBe(503);expect(response.headers['cache-control']).toBe('no-store');
  expect(response.body).not.toContain('private');
});
