import type { LyricsResponse } from '@hirmos/contracts';
import { adjustLocalLyrics, fetchExtra, localCover, lyricsQuality, prepareExtras, savedLyrics } from './download-extras';
import { LocalDownloads, type LocalDownload } from './local-downloads';

const owner='11111111-1111-4111-8111-111111111111';
const signal=()=>new AbortController().signal;
const json=(value:unknown)=>new Blob([JSON.stringify(value)]);
const lyric=(quality=2):LyricsResponse=>({availability:'available',adjustmentMs:0,lyrics:[{
  synced:quality>1,displayArtist:null,displayTitle:null,language:null,
  lines:[{text:'Synthetic line',startMs:quality>1?1000:null,
    ...(quality===3?{words:[{text:'Synthetic line',startMs:1000,endMs:2000}]}:{})}],
}]});
const response=(data:unknown)=>new Response(JSON.stringify(data),{headers:{'x-hirmos-account-id':owner}});
beforeEach(async()=>vi.stubGlobal('Blob',(await new Response('').blob()).constructor));
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();});
it.each([401,403])('does not retry HTTP %s or record an absent lyric',async status=>{
  const fetch=vi.fn(async()=>new Response(null,{status}));vi.stubGlobal('fetch',fetch);
  await expect(fetchExtra('/api/music/tracks/one/lyrics',owner,1024,signal())).rejects.toMatchObject({code:`HTTP_${status}`});
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('distinguishes absence, rejects foreign bytes and obeys the URL boundary',async()=>{
  const fetch=vi.fn().mockResolvedValueOnce(new Response(null,{status:404})).mockResolvedValueOnce(new Response('foreign'));
  vi.stubGlobal('fetch',fetch);
  expect(await fetchExtra('/api/music/tracks/one/lyrics',owner,1024,signal())).toBeNull();
  await expect(fetchExtra('/api/music/tracks/one/lyrics',owner,1024,signal())).rejects.toMatchObject({code:'ACCOUNT_CHANGED'});
  await expect(fetchExtra('https://provider.test/image',owner,1024,signal())).rejects.toThrow('INVALID_EXTRA_URL');
  expect(fetch).toHaveBeenCalledTimes(2);
});
it('caps streamed bytes even without Content-Length',async()=>{
  const fetch=vi.fn(async()=>response(lyric()));vi.stubGlobal('fetch',fetch);
  await expect(fetchExtra('/api/music/tracks/one/lyrics',owner,8,signal())).rejects.toMatchObject({code:'INVALID_RESPONSE'});
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('retries one transient GET and bypasses browser caches',async()=>{
  vi.useFakeTimers();const fetch=vi.fn().mockResolvedValueOnce(new Response(null,{status:503})).mockResolvedValueOnce(response(lyric()));
  vi.stubGlobal('fetch',fetch);const result=fetchExtra('/api/music/tracks/one/lyrics',owner,1024,signal());
  await vi.advanceTimersByTimeAsync(800);
  expect(await savedLyrics(await result)).toEqual(lyric());expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch).toHaveBeenLastCalledWith('/api/music/tracks/one/lyrics',expect.objectContaining({cache:'no-store',credentials:'same-origin',redirect:'error'}));
});
it('honors Retry-After outside the total budget and cancellation before starting',async()=>{
  const fetch=vi.fn(async()=>new Response(null,{status:429,headers:{'retry-after':'120'}}));vi.stubGlobal('fetch',fetch);
  await expect(fetchExtra('/api/music/tracks/one/lyrics',owner,1024,signal())).rejects.toMatchObject({code:'HTTP_429',retryAt:expect.any(Number)});
  const aborted=new AbortController();aborted.abort();
  await expect(fetchExtra('/api/music/tracks/one/lyrics',owner,1024,aborted.signal)).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('accepts raster signatures only and validates timing metadata',async()=>{
  expect(await localCover(new Blob(['<svg/>'],{type:'image/png'}))).toBeNull();
  expect((await localCover(new Blob([new Uint8Array([137,80,78,71,13,10,26,10])])) )?.type).toBe('image/png');
  expect(await savedLyrics(json({...lyric(),adjustmentMs:Infinity}))).toBeNull();
  expect(await savedLyrics(json({...lyric(),lyrics:[{...lyric().lyrics[0],lines:[{text:'broken',startMs:-1}]}]}))).toBeNull();
  expect([1,2,3].map(q=>lyricsQuality(lyric(q)))).toEqual([1,2,3]);
});
function fixture(previous:LyricsResponse|null=null){
  let saved=previous?json(previous):null;
  const row={owner,fileId:'file',state:'ready',track:{reference:'one',coverUrl:null}} as LocalDownload;
  const write=vi.fn(async(_ref,_id,_name,incoming,_signal,guard,merge)=>{
    guard();saved=merge?await merge(saved,incoming):incoming;
  });
  const store={readExtra:async(_ref:string,name:string)=>name==='lyrics'?saved:null,saveExtra:write,list:async()=>[row]} as unknown as LocalDownloads;
  return {store,row,write,read:()=>saved,set:(value:LyricsResponse)=>{saved=json(value);}};
}
it('promotes line to word timing, preserves local adjustment and then stops querying',async()=>{
  const f=fixture({...lyric(),adjustmentMs:700});const fetch=vi.fn(async()=>response(lyric(3)));vi.stubGlobal('fetch',fetch);
  await prepareExtras(f.store,f.row,signal(),()=>undefined);
  expect(await savedLyrics(f.read())).toEqual({...lyric(3),adjustmentMs:700});
  await prepareExtras(f.store,f.row,signal(),()=>undefined);expect(fetch).toHaveBeenCalledTimes(1);
  await adjustLocalLyrics(f.store,'one',-200,()=>undefined);
  expect((await savedLyrics(f.read()))?.adjustmentMs).toBe(-200);expect(fetch).toHaveBeenCalledTimes(1);
});
it.each(['not_found','temporarily_unavailable','lower'])('preserves good lyrics on %s',async kind=>{
  const f=fixture(lyric());vi.stubGlobal('fetch',vi.fn(async()=>response(kind==='lower'?lyric(1):{...lyric(),lyrics:[],availability:kind})));
  const work=prepareExtras(f.store,f.row,signal(),()=>undefined);
  if(kind==='temporarily_unavailable')await expect(work).rejects.toThrow('EXTRAS_TEMPORARY');else await work;
  expect(await savedLyrics(f.read())).toEqual(lyric());expect(f.write).not.toHaveBeenCalled();
});
it('merges under the storage lock, refusing a stale response that would downgrade another tab',async()=>{
  const f=fixture(lyric(1));vi.stubGlobal('fetch',vi.fn(async()=>{f.set({...lyric(3),adjustmentMs:900});return response(lyric(2));}));
  await prepareExtras(f.store,f.row,signal(),()=>undefined);
  expect(await savedLyrics(f.read())).toEqual({...lyric(3),adjustmentMs:900});
});
