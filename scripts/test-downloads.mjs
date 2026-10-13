// Real local HTTP transport with synthetic audio only; no PG, provider or production access.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { buildApp } from '../apps/api/dist/app.js';
import { loadConfig } from '../apps/api/dist/config.js';
import { NavidromeAdapter } from '../apps/api/dist/music-source/navidrome-adapter.js';
import { encodeTrackReference, decodeTrackReference } from '../apps/api/dist/music-source/track-reference.js';

let mode = 'healthy';
let cancelled = 0;
let providerCalls = 0;
const body = Buffer.alloc(256 * 1024, 7);
const provider = createServer((req, res) => {
  assert.equal(new URL(req.url, 'http://localhost').pathname, '/rest/download.view');
  providerCalls++;
  if (mode === 'waiting') { res.writeHead(429, { 'retry-after':'60' }); res.end(); return; }
  if (mode === 'missing') { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type':'audio/flac', 'content-length':body.length });
  if (mode === 'truncated') { res.end(body.subarray(0, 1024)); return; }
  if (mode === 'stalled') {
    res.write(body.subarray(0, 1024));
    res.on('close', () => { cancelled++; });
    return;
  }
  res.end(body);
});
provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
const adapter = new NavidromeAdapter({ baseUrl:new URL(`http://127.0.0.1:${provider.address().port}`),
  username:'synthetic', password:'synthetic-only' });
const app = await buildApp({ config:loadConfig({NODE_ENV:'test'}),
  musicSourceService:{ download:(reference, signal) => adapter.getDownload(decodeTrackReference(reference).remoteId, signal) },
  authService:{ authenticate:async token => token === 'synthetic' ? { id:'test-session', response:{
    user:{id:'test-user',email:'test@example.test',role:'user',displayName:'Test'},
    expiresAt:new Date(Date.now()+60000).toISOString(),
  }} : null },
});
const address = await app.listen({host:'127.0.0.1',port:0});
const ref = encodeTrackReference('11111111-1111-4111-8111-111111111111','original');
const url = `${address}/api/music/tracks/${ref}/download`;
const headers = {cookie:'hirmos_session=synthetic'};
const controllers = [];
try {
  assert.equal((await fetch(url)).status,401);
  assert.equal(providerCalls,0);
  const response = await fetch(url,{headers});
  assert.equal(response.status,200); assert.equal(response.headers.get('cache-control'),'private, no-store');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()),body);
  console.log('PASS original HTTP bytes with authentication, no-store and unchanged payload');
  mode = 'stalled';
  for(let i=0;i<2;i++) {
    const controller = new AbortController(); controllers.push(controller);
    const response = await fetch(url,{headers,signal:controller.signal});
    assert.equal(response.status,200);
  }
  const busy = await fetch(url,{headers});
  assert.equal(busy.status,429); assert.equal(busy.headers.get('retry-after'),'5');
  controllers.forEach(c=>c.abort());
  const deadline=Date.now()+2000;
  while(cancelled<2 && Date.now()<deadline) await new Promise(r=>setTimeout(r,20));
  assert.equal(cancelled,2);
  mode='healthy';
  const next=await fetch(url,{headers}); assert.equal(next.status,200); await next.arrayBuffer();
  console.log('PASS cancelling two clients closes provider bodies and frees concurrency slots');
  mode='truncated';
  await assert.rejects(async()=>{
    const response=await fetch(url,{headers,signal:AbortSignal.timeout(10000)});
    await response.arrayBuffer();
  }, error => error.name !== 'TimeoutError');
  console.log('PASS truncated HTTP transfer cannot complete as a valid original');
  mode='waiting';
  const before=providerCalls;
  const waiting=await fetch(url,{headers});
  assert.equal(waiting.status,503); assert.equal(waiting.headers.get('retry-after'),'60');
  assert.equal(providerCalls,before+1);
  mode='missing'; assert.equal((await fetch(url,{headers})).status,404);
  console.log('PASS Retry-After beyond budget is returned promptly; missing file stays distinct');
} finally {
  controllers.forEach(c=>c.abort());
  provider.closeAllConnections();
  await app.close();
  await new Promise(resolve=>provider.close(resolve));
}
