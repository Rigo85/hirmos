/** Read-only verification of the public build, independent of Angular cache names. */
export interface ShellManifest {index:string;urls:string[];hashes:Record<string,string>}
export function shellManifest(raw:unknown):ShellManifest {
  const r=raw as {index?:unknown;assetGroups?:{installMode?:string;urls?:unknown;patterns?:unknown[]}[];hashTable?:Record<string,unknown>};
  const group=r?.assetGroups?.[0],urls=group?.urls;
  if(r?.index!=='/index.html'||r.assetGroups?.length!==1||group?.installMode!=='prefetch'||group.patterns?.length
    ||!Array.isArray(urls)||!urls.length||urls.length>1000||!urls.includes('/index.html')
    ||new Set(urls).size!==urls.length||urls.some(url=>typeof url!=='string'||!/^\/(?:[\w.-]+\.(?:html|js|css|ico|webmanifest)|(?:icons|media)\/[\w./-]+)$/.test(url)
      ||url.includes('..')||!/^[a-f0-9]{40}$/.test(String(r.hashTable?.[url]))))throw new Error('INVALID_MANIFEST');
  return {index:r.index,urls,hashes:Object.fromEntries(urls.map(url=>[url,r.hashTable![url] as string]))};
}
export async function boundedBytes(response:Response,limit:number,signal:AbortSignal):Promise<Uint8Array<ArrayBuffer>> {
  if(response.status!==200||!response.body||Number(response.headers.get('content-length'))>limit){await response.body?.cancel();throw new Error('INVALID_RESPONSE');}
  const reader=response.body.getReader(),parts:Uint8Array[]=[];let size=0;
  const abort=()=>{void reader.cancel().catch(()=>undefined);};signal.addEventListener('abort',abort,{once:true});
  try{while(true){signal.throwIfAborted();const next=await reader.read();signal.throwIfAborted();if(next.done)break;
    size+=next.value.length;if(size>limit)throw new Error('TOO_LARGE');parts.push(next.value);
  }}finally{signal.removeEventListener('abort',abort);await reader.cancel().catch(()=>undefined);reader.releaseLock();}
  const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}return bytes;
}
export async function auditShell(manifest:ShellManifest,storage:Pick<CacheStorage,'keys'|'open'>,origin:string,signal:AbortSignal):Promise<boolean> {
  const names=await storage.keys();if(names.length>100)throw new Error('TOO_MANY_CACHES');
  for(const name of names){
    signal.throwIfAborted();const cache=await storage.open(name);let total=0,complete=true;
    // All files must belong to one complete version, not a union of partial caches.
    for(const url of manifest.urls){
      signal.throwIfAborted();const response=await cache.match(new URL(url,origin).href);
      if(!response||response.status!==200){complete=false;break;}
      const bytes=await boundedBytes(response,8*1024**2,signal);total+=bytes.length;
      if(total>30*1024**2)throw new Error('TOO_LARGE');
      const digest=new Uint8Array(await crypto.subtle.digest('SHA-1',bytes));
      const hash=Array.from(digest,b=>b.toString(16).padStart(2,'0')).join('');
      if(hash!==manifest.hashes[url]){complete=false;break;}
    }
    if(complete){signal.throwIfAborted();return true;}
  }
  return false;
}
/** Explicit safe public GET, with two attempts and a shared 15s budget. */
export async function fetchShellManifest(signal:AbortSignal):Promise<unknown> {
  const budget=AbortSignal.any([signal,AbortSignal.timeout(15000)]);
  for(let attempt=0;attempt<2;attempt++){
    budget.throwIfAborted();let delay=400+Math.random()*300;
    try{
      const response=await fetch('/ngsw.json?ngsw-bypass=true',{credentials:'omit',cache:'no-store',redirect:'error',signal:AbortSignal.any([budget,AbortSignal.timeout(6000)])});
      if(response.status!==200){
        await response.body?.cancel();
        if(![408,425,429].includes(response.status)&&response.status<500)throw new Error('PERMANENT');
        const retry=response.headers.get('retry-after');
        if(retry){const seconds=Number(retry);delay=Math.max(delay,Number.isFinite(seconds)?seconds*1000:Date.parse(retry)-Date.now());}
        if(delay>6000)throw new Error('WAIT_REQUIRED');throw new TypeError('TEMPORARY');
      }
      return JSON.parse(new TextDecoder().decode(await boundedBytes(response,256*1024,budget)));
    }catch(error){
      budget.throwIfAborted();
      if(attempt||!(error instanceof TypeError||error instanceof DOMException&&error.name==='TimeoutError'))throw error;
      await new Promise<void>((resolve,reject)=>{
        const finish=()=>{budget.removeEventListener('abort',cancel);resolve();},timer=setTimeout(finish,delay);
        const cancel=()=>{clearTimeout(timer);budget.removeEventListener('abort',cancel);reject(budget.reason);};
        budget.addEventListener('abort',cancel,{once:true});
      });
    }
  }
  throw new Error('UNAVAILABLE');
}
