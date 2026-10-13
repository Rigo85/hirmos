import type { LyricsResponse } from '@hirmos/contracts';
import { DownloadFailure, retryTime } from './download-transport';
import { LocalDownloads, type LocalDownload } from './local-downloads';

const MAX_COVER = 2 * 1024 ** 2, MAX_LYRICS = 1024 ** 2;
const temporary = (status:number) => [408,425,429].includes(status) || status >= 500;

/** Bounded safe GETs only, to Hirmos. Providers remain behind its normal cache. */
export async function fetchExtra(url:string, owner:string, limit:number, signal:AbortSignal):Promise<Blob|null> {
  if (!/^\/api\/music\/(covers\/[A-Za-z0-9_-]+\?size=320|tracks\/[A-Za-z0-9_-]+\/lyrics)$/.test(url)) throw new Error('INVALID_EXTRA_URL');
  const deadline = Date.now()+25000;
  for (let attempt=0;attempt<2;attempt++) {
    signal.throwIfAborted();
    const bounded=AbortSignal.any([signal,AbortSignal.timeout(Math.max(1,Math.min(12000,deadline-Date.now())))]);
    let retryAt=0;
    try {
      const response=await fetch(url,{credentials:'same-origin',cache:'no-store',redirect:'error',signal:bounded,headers:{'ngsw-bypass':'true'}});
      if (response.status!==200) {
        await response.body?.cancel();
        if (response.status===404) return null;
        retryAt=retryTime(response.headers.get('retry-after'));
        throw new DownloadFailure(`HTTP_${response.status}`,retryAt);
      }
      if (response.headers.get('x-hirmos-account-id')!==owner) {await response.body?.cancel();throw new DownloadFailure('ACCOUNT_CHANGED');}
      if (!response.body) throw new DownloadFailure('INVALID_RESPONSE');
      const length=Number(response.headers.get('content-length'));
      if (length>limit) {await response.body.cancel();throw new DownloadFailure('INVALID_RESPONSE');}
      const reader=response.body.getReader(),parts:Uint8Array<ArrayBuffer>[]=[];
      let bytes=0;
      try {
        while (true) {
          bounded.throwIfAborted();const item=await reader.read();bounded.throwIfAborted();
          if(item.done) break;
          bytes+=item.value.byteLength;if(bytes>limit)throw new DownloadFailure('INVALID_RESPONSE');
          parts.push(item.value as Uint8Array<ArrayBuffer>);
        }
      } finally {await reader.cancel().catch(()=>undefined);reader.releaseLock();}
      if(!bytes)throw new DownloadFailure('INVALID_RESPONSE');
      return new Blob(parts,{type:response.headers.get('content-type')?.split(';')[0]??''});
    } catch(error) {
      signal.throwIfAborted();
      const status=error instanceof DownloadFailure ? Number(error.code.replace('HTTP_','')) : null;
      if(attempt===1 || (status!==null && !temporary(status)))throw error;
      const wait=Math.max(400*2**attempt+Math.random()*300,retryAt-Date.now());
      if(Date.now()+wait+1000>=deadline)throw error;
      signal.throwIfAborted();
      await new Promise<void>((resolve,reject)=>{
        const done=()=>{signal.removeEventListener('abort',cancel);resolve();};
        const timer=setTimeout(done,wait);
        const cancel=()=>{clearTimeout(timer);signal.removeEventListener('abort',cancel);reject(signal.reason);};
        signal.addEventListener('abort',cancel,{once:true});
      });
    }
  }
  throw new DownloadFailure('NETWORK');
}

/** Accept only raster signatures; no saved SVG/HTML or remote fallback URL. */
export async function localCover(blob:Blob|null):Promise<Blob|null> {
  if(!blob || !blob.size || blob.size>MAX_COVER)return null;
  const b=new Uint8Array(await blob.slice(0,16).arrayBuffer());
  const type=b[0]===0xff&&b[1]===0xd8&&b[2]===0xff?'image/jpeg':
    [137,80,78,71,13,10,26,10].every((v,i)=>b[i]===v)?'image/png':
    String.fromCharCode(...b.slice(0,4))==='RIFF'&&String.fromCharCode(...b.slice(8,12))==='WEBP'?'image/webp':
    ['GIF87a','GIF89a'].includes(String.fromCharCode(...b.slice(0,6)))?'image/gif':null;
  return type?blob.slice(0,blob.size,type):null;
}

export function validLyrics(raw:unknown):raw is LyricsResponse {
  const r=raw as LyricsResponse|null;
  const time=(n:unknown)=>n===null||(Number.isSafeInteger(n)&&Number(n)>=0&&Number(n)<=86400000);
  const text=(s:unknown)=>typeof s==='string'&&s.length<=16000;
  return !!r&&['available','not_found','temporarily_unavailable'].includes(r.availability)
    &&Number.isInteger(r.adjustmentMs)&&Math.abs(r.adjustmentMs)<=30000
    &&Array.isArray(r.lyrics)&&r.lyrics.length<=10&&r.lyrics.every(doc=>doc&&typeof doc.synced==='boolean'
      &&[doc.displayArtist,doc.displayTitle,doc.language].every(s=>s===null||text(s))
      &&Array.isArray(doc.lines)&&doc.lines.length<=10000&&doc.lines.every(line=>line&&text(line.text)&&time(line.startMs)
        &&(line.endMs===undefined||time(line.endMs))&&(line.words===undefined||Array.isArray(line.words)&&line.words.length<=1000
          &&line.words.every(word=>word&&text(word.text)&&word.startMs!==null&&time(word.startMs)&&time(word.endMs)))));
}
export async function savedLyrics(blob:Blob|null):Promise<LyricsResponse|null> {
  if(!blob||blob.size>MAX_LYRICS)return null;
  try {const value:unknown=JSON.parse(await blob.text());return validLyrics(value)?value:null;}catch{return null;}
}
export function lyricsQuality(value:LyricsResponse|null):number {
  return Math.max(0,...(value?.lyrics??[]).map(doc=>!doc.lines.some(l=>l.text.trim())?0:
    doc.synced&&doc.lines.some(l=>l.startMs!==null)?doc.lines.some(l=>l.words?.length)?3:2:1));
}
const asBlob=(value:LyricsResponse)=>new Blob([JSON.stringify(value)],{type:'application/json'});
async function promoteLyrics(previous:Blob|null,incoming:Blob):Promise<Blob> {
  const old=await savedLyrics(previous),next=await savedLyrics(incoming);
  if(!next)throw new Error('INVALID_EXTRA');
  if(old && lyricsQuality(old)>=lyricsQuality(next))return previous!;
  return asBlob({...next,adjustmentMs:old?.adjustmentMs??next.adjustmentMs});
}

export async function prepareExtras(store:LocalDownloads,row:LocalDownload,signal:AbortSignal,guard:()=>void):Promise<void> {
  guard();signal.throwIfAborted();
  const cover=await localCover(await store.readExtra(row.track.reference,'cover'));
  if(!cover&&row.track.coverUrl) {
    const url=row.track.coverUrl.split('?')[0]+'?size=320';
    const obtained=await fetchExtra(url,row.owner,MAX_COVER,signal);
    if(obtained) {
      const valid=await localCover(obtained);if(!valid)throw new DownloadFailure('INVALID_RESPONSE');
      await store.saveExtra(row.track.reference,row.fileId,'cover',valid,signal,guard);
    }
  }
  guard();signal.throwIfAborted();
  const old=await savedLyrics(await store.readExtra(row.track.reference,'lyrics'));
  if(lyricsQuality(old)===3)return;
  const obtained=await fetchExtra(`/api/music/tracks/${row.track.reference}/lyrics`,row.owner,MAX_LYRICS,signal);
  if(!obtained)return;
  const next=await savedLyrics(obtained);
  if(!next)throw new DownloadFailure('INVALID_RESPONSE');
  if(next.availability==='temporarily_unavailable')throw new DownloadFailure('EXTRAS_TEMPORARY');
  if(lyricsQuality(next)>lyricsQuality(old))await store.saveExtra(row.track.reference,row.fileId,'lyrics',asBlob(next),signal,guard,promoteLyrics);
}

export async function adjustLocalLyrics(store:LocalDownloads,reference:string,adjustmentMs:number,guard:()=>void):Promise<{adjustmentMs:number}> {
  if(!Number.isInteger(adjustmentMs)||Math.abs(adjustmentMs)>30000)throw new Error('INVALID_EXTRA');
  const row=(await store.list()).find(r=>r.track.reference===reference&&r.state==='ready');
  if(!row)throw new Error('LOCAL_AUDIO_MISSING');
  await store.saveExtra(reference,row.fileId,'lyrics',new Blob(['{}']),new AbortController().signal,guard,async existing=>{
    const lyrics=await savedLyrics(existing);if(!lyrics)throw new Error('LOCAL_LYRICS_MISSING');
    return asBlob({...lyrics,adjustmentMs});
  });
  return {adjustmentMs};
}
