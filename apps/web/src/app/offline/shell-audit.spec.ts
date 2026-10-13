import {auditShell,boundedBytes,fetchShellManifest,shellManifest} from './shell-audit';
const hash=async(text:string)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-1',new TextEncoder().encode(text))),b=>b.toString(16).padStart(2,'0')).join('');
const raw=async()=>({index:'/index.html',assetGroups:[{installMode:'prefetch',patterns:[],urls:['/index.html','/main.js']}],hashTable:{'/index.html':await hash('index'),'/main.js':await hash('js')}});
function storage(groups:Record<string,Record<string,string>>){return {keys:async()=>Object.keys(groups),open:vi.fn(async(name:string)=>({match:vi.fn(async(url:string)=>{
  const text=groups[name][new URL(url).pathname];return text===undefined?undefined:new Response(text);
})}))} as unknown as Pick<CacheStorage,'keys'|'open'>;}
const signal=()=>new AbortController().signal;
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();});
it('verifies the complete public build hashes without depending on Angular cache names',async()=>{
  expect(await auditShell(shellManifest(await raw()),storage({arbitrary:{'/index.html':'index','/main.js':'js'}}),'https://example.test',signal())).toBe(true);
});
it('does not combine partial versions or accept modified bytes',async()=>{
  const manifest=shellManifest(await raw());
  expect(await auditShell(manifest,storage({a:{'/index.html':'index'},b:{'/main.js':'js'}}),'https://example.test',signal())).toBe(false);
  expect(await auditShell(manifest,storage({a:{'/index.html':'index','/main.js':'corrupt'}}),'https://example.test',signal())).toBe(false);
});
it('rejects private or unbounded manifests and cancelled/oversize reads',async()=>{
  const good=await raw();
  for(const url of ['/api/session','//outside.test/js','/icons/../api/session']){
    expect(()=>shellManifest({...good,assetGroups:[{installMode:'prefetch',urls:['/index.html',url]}]})).toThrow();
  }
  await expect(boundedBytes(new Response('oversize'),2,signal())).rejects.toThrow('TOO_LARGE');
  const controller=new AbortController();controller.abort();
  await expect(auditShell(shellManifest(good),storage({a:{}}),'https://example.test',controller.signal)).rejects.toThrow();
});
it('uses an explicit unauthenticated GET and does not retry permanent errors or long Retry-After',async()=>{
  const fetcher=vi.fn().mockResolvedValue(new Response('{}',{status:403}));vi.stubGlobal('fetch',fetcher);
  await expect(fetchShellManifest(signal())).rejects.toThrow();expect(fetcher).toHaveBeenCalledOnce();
  expect(fetcher).toHaveBeenCalledWith('/ngsw.json?ngsw-bypass=true',expect.objectContaining({credentials:'omit',cache:'no-store',redirect:'error',signal:expect.any(AbortSignal)}));
  fetcher.mockClear().mockResolvedValue(new Response('',{status:429,headers:{'Retry-After':'120'}}));
  await expect(fetchShellManifest(signal())).rejects.toThrow('WAIT_REQUIRED');expect(fetcher).toHaveBeenCalledOnce();
});
it('retries a recoverable failure once and stops on cancellation',async()=>{
  vi.useFakeTimers();const fetcher=vi.fn().mockRejectedValueOnce(new TypeError('network')).mockResolvedValue(new Response(JSON.stringify(await raw())));vi.stubGlobal('fetch',fetcher);
  const pending=fetchShellManifest(signal());await vi.advanceTimersByTimeAsync(1000);
  expect((await pending as any).index).toBe('/index.html');expect(fetcher).toHaveBeenCalledTimes(2);
  const controller=new AbortController();controller.abort();await expect(fetchShellManifest(controller.signal)).rejects.toThrow();expect(fetcher).toHaveBeenCalledTimes(2);
});
