// Real IndexedDB in a disposable browser profile. Never opens a user's profile.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {build} from 'esbuild';
import {chromium} from '@playwright/test';
const bundle=await build({entryPoints:['apps/web/src/app/offline/listen-outbox.ts'],bundle:true,write:false,format:'iife',globalName:'Outbox'});
const server=createServer((_req,res)=>{res.setHeader('content-type','text/html');res.end('<!doctype html><title>Isolated outbox test</title>');});
server.listen(0,'127.0.0.1');await once(server,'listening');
const profile=await mkdtemp(join(tmpdir(),'hirmos-listen-outbox-'));let context;
const open=async()=>{
  context=await chromium.launchPersistentContext(profile,{headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  const page=await context.newPage();await page.goto(`http://127.0.0.1:${server.address().port}`);await page.addScriptTag({content:bundle.outputFiles[0].text});return page;
};
try{
  let page=await open();
  await page.evaluate(async()=>{
    const box=new Outbox.BrowserListenOutbox('synthetic-listens');
    const report={id:crypto.randomUUID(),executionId:crypto.randomUUID(),reference:'synthetic',startedAt:'2026-10-12T00:00:00.000Z',at:'2026-10-12T00:00:05.000Z',heardMs:5000};
    await box.put('a',report);await box.put('a',report);await box.put('b',report);
    if((await box.batch('a',Date.now())).length!==1)throw Error('duplicate');
    await box.cooldown('a',Date.now()+120000);
  });
  await context.close();page=await open();
  assert.deepEqual(await page.evaluate(async()=>{
    const box=new Outbox.BrowserListenOutbox('synthetic-listens');return [(await box.batch('a',Date.now())).length,(await box.batch('b',Date.now())).length];
  }),[0,1]);
  console.log('PASS real browser restart retains reports, isolates owners and persists Retry-After');
  assert.deepEqual(await page.evaluate(async()=>{
    const box=new Outbox.BrowserListenOutbox('synthetic-listens'),now=Date.now()+121000;
    const a=await box.batch('a',now),ids=a.map(r=>r.id);
    await box.acknowledge('a',ids,{accepted:[],rejected:[{id:ids[0],code:'UNKNOWN_TRACK'}]},now);
    const waiting=(await box.batch('a',now+1000)).length;
    const retry=(await box.batch('a',now+3600001)).length;
    await box.acknowledge('a',ids,{accepted:ids,rejected:[]},now);
    return [waiting,retry,(await box.batch('a',now+3600001)).length,(await box.batch('b',now)).length];
  }),[0,1,0,1]);
  console.log('PASS ACK deletes only committed matching account rows; catalog absence delays without data loss');
  assert.equal(await page.evaluate(async()=>{
    const box=new Outbox.BrowserListenOutbox('synthetic-listens'),rows=await box.batch('b',Date.now());
    await box.acknowledge('b',[rows[0].id],{accepted:[],rejected:[{id:rows[0].id,code:'ID_CONFLICT'}]},Date.now());
    return (await box.batch('b',Date.now()+86400000)).length;
  }),0);
  console.log('PASS invalid payload is retained in quarantine, not endlessly retried or silently erased');
}finally{await context?.close();await new Promise(r=>server.close(r));await rm(profile,{recursive:true,force:true});}
