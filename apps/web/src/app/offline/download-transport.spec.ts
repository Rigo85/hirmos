import { afterEach, expect, it, vi } from 'vitest';
import { DownloadFailure, downloadOriginal, retryTime } from './download-transport';
const owner='11111111-1111-4111-8111-111111111111';
function audio(headers:Record<string,string>={}) {
  return new Response(new Uint8Array([1,2,3]),{headers:{'content-type':'audio/flac','content-length':'3','x-hirmos-account-id':owner,...headers}});
}
async function consume(body:ReadableStream<Uint8Array>) {
  const reader=body.getReader();const bytes:number[]=[];
  try{while(true){const value=await reader.read();if(value.done)return bytes;bytes.push(...value.value);}}
  finally{reader.releaseLock();}
}
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();});
it('streams original bytes and reports progress without range, conversion or cache',async()=>{
  const fetch=vi.fn(async()=>audio());vi.stubGlobal('fetch',fetch);
  const progress=vi.fn();const source=await downloadOriginal('dHJhY2s',owner,new AbortController().signal,progress);
  expect(await consume(source.body)).toEqual([1,2,3]);
  expect(progress).toHaveBeenLastCalledWith(3,3);
  expect(fetch).toHaveBeenCalledWith('/api/music/tracks/dHJhY2s/download',expect.objectContaining({cache:'no-store',credentials:'same-origin',redirect:'error'}));
});
it.each([401,403,404])('never retries nonrecoverable HTTP %s',async status=>{
  const fetch=vi.fn(async()=>new Response(null,{status}));vi.stubGlobal('fetch',fetch);
  await expect(downloadOriginal('dHJhY2s',owner,new AbortController().signal,vi.fn())).rejects.toMatchObject({code:`HTTP_${status}`});
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('refuses a response for another account before publishing bytes',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>audio({'x-hirmos-account-id':'other'})));
  await expect(downloadOriginal('dHJhY2s',owner,new AbortController().signal,vi.fn())).rejects.toMatchObject({code:'ACCOUNT_CHANGED'});
});
it('respects Retry-After outside its budget without a second request',async()=>{
  const fetch=vi.fn(async()=>new Response(null,{status:429,headers:{'retry-after':'120'}}));vi.stubGlobal('fetch',fetch);
  await expect(downloadOriginal('dHJhY2s',owner,new AbortController().signal,vi.fn())).rejects.toMatchObject({code:'HTTP_429',retryAt:expect.any(Number)});
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('performs one bounded recovery after a temporary header failure',async()=>{
  vi.useFakeTimers();const fetch=vi.fn().mockResolvedValueOnce(new Response(null,{status:503})).mockResolvedValueOnce(audio());vi.stubGlobal('fetch',fetch);
  const result=downloadOriginal('dHJhY2s',owner,new AbortController().signal,vi.fn());
  await vi.advanceTimersByTimeAsync(800);
  expect(await consume((await result).body)).toEqual([1,2,3]);expect(fetch).toHaveBeenCalledTimes(2);
});
it('body length mismatch fails rather than retrying or publishing a partial file',async()=>{
  const fetch=vi.fn(async()=>audio({'content-length':'4'}));vi.stubGlobal('fetch',fetch);
  const source=await downloadOriginal('dHJhY2s',owner,new AbortController().signal,vi.fn());
  await expect(consume(source.body)).rejects.toMatchObject({code:'TRUNCATED'});expect(fetch).toHaveBeenCalledTimes(1);
});
it('cancel before starting never calls the server',async()=>{
  const controller=new AbortController();controller.abort();const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
  await expect(downloadOriginal('dHJhY2s',owner,controller.signal,vi.fn())).rejects.toThrow();expect(fetch).not.toHaveBeenCalled();
});
it('handles seconds and HTTP-date Retry-After values',()=>{
  const now=Date.parse('2026-01-01T00:00:00Z');
  expect(retryTime('5',now)).toBe(now+5000);
  expect(retryTime('Thu, 01 Jan 2026 00:00:08 GMT',now)).toBe(now+8000);
  expect(retryTime('invalid',now)).toBe(0);
});
