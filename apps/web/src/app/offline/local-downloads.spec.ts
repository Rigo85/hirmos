import { expect, it, vi } from 'vitest';
import { LocalDownloads, type LocalDownload, type LocalPorts, validRecord } from './local-downloads';

const owner = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const track = {reference:'c291cmNlAHRyYWNr',title:'Synthetic',artist:'Test',album:'Test'};
const input = (bytes = [1,2,3]) => async () => new ReadableStream<Uint8Array>({start(c) {c.enqueue(new Uint8Array(bytes));c.close();}});
function fixture() {
  const rows = new Map<string, LocalDownload>();
  const files = new Map<string, Blob>();
  const values = new WeakMap<Blob, Uint8Array>();
  const manifests = new Map<string, unknown>();
  const commits: string[] = [];
  let sequence = 0;
  const key = (owner: string, id: string) => `${owner}/${id}`;
  const notFound = () => new DOMException('Missing synthetic file', 'NotFoundError');
  const makeFile = (bytes: number[]) => { const b = new Blob([new Uint8Array(bytes)]); values.set(b, new Uint8Array(bytes)); return b; };
  const ports: LocalPorts = {
    index:{
      get:async (owner, ref) => structuredClone(rows.get(key(owner, ref))),
      list:async owner => structuredClone([...rows.values()].filter(r => r.owner === owner)),
      put:vi.fn(async row => { rows.set(key(row.owner,row.track.reference), structuredClone(row)); commits.push(row.state); }),
    },
    files:{
      remove:async(owner,id)=>{ files.delete(key(owner,id)); manifests.delete(key(owner,id)); },
      write:async (owner,id,body,signal) => {
        const reader=body.getReader(); const chunks:number[]=[];
        try { while(true) { signal?.throwIfAborted(); const {done,value}=await reader.read(); if(done) break; chunks.push(...value); } }
        finally {await reader.cancel().catch(()=>undefined);}
        files.set(key(owner,id),makeFile(chunks)); commits.push('file'); return chunks.length;
      },
      open:async (owner,id) => {const file=files.get(key(owner,id)); if(!file) throw notFound(); return file;},
      manifest:async (owner,id) => {const row=manifests.get(key(owner,id)); if(!row) throw notFound(); return structuredClone(row);},
      publish:async row => { manifests.set(key(row.owner,row.fileId),structuredClone(row)); commits.push('manifest'); },
      ids:async owner => [...files.keys()].filter(k=>k.startsWith(owner+'/')).map(k=>k.slice(owner.length+1)),
    },
    lock:vi.fn(async (_owner, fn, signal) => { signal?.throwIfAborted(); return fn(); }),
    // Deterministic fake fingerprint; browser fixture exercises real WebCrypto on OPFS bytes.
    fingerprint:async file => `sha256-chunks-v1:${[...values.get(file)!].map(b=>b.toString(16).padStart(2,'0')).join('').padEnd(64,'0')}`,
    space:vi.fn(async()=>undefined),
    uuid:()=>`00000000-0000-4000-8000-${String(++sequence).padStart(12,'0')}`,
  };
  return {ports,rows,files,manifests,commits,key,makeFile,store:new LocalDownloads(owner,ports)};
}
it('commits readiness only after file, fingerprint and recovery manifest', async()=>{
  const f=fixture(); const row=await f.store.save(track,'audio/flac',3,input());
  expect(row.state).toBe('ready'); expect(row.bytes).toBe(3);
  expect(f.commits).toEqual(['writing','file','manifest','ready']);
  expect(f.ports.lock).toHaveBeenCalledWith(owner,expect.any(Function),undefined);
});
it('opens only verified local bytes with their original MIME, isolated by owner',async()=>{
  const f=fixture();await f.store.save(track,'audio/flac',3,input());
  const opened=await f.store.openAudio(track.reference);
  expect(opened.file.size).toBe(3);expect(opened.file.type).toBe('audio/flac');
  await expect(new LocalDownloads(other,f.ports).openAudio(track.reference)).rejects.toThrow('LOCAL_AUDIO_MISSING');
});
it('checks actual bytes again at playback and reports disappearance without redownload',async()=>{
  const f=fixture(),row=await f.store.save(track,'audio/flac',3,input());
  f.files.delete(f.key(owner,row.fileId));
  await expect(f.store.openAudio(track.reference)).rejects.toThrow('LOCAL_AUDIO_MISSING');
  expect((await f.store.list())[0].state).toBe('missing');
});
it('refuses truncated bytes and distinguishes permission failures from missing files',async()=>{
  const f=fixture(),row=await f.store.save(track,'audio/flac',3,input());
  f.ports.files.open=async()=>{throw new DOMException('Permission','NotAllowedError');};
  await expect(f.store.openAudio(track.reference)).rejects.toThrow('Permission');
  expect((await f.store.list())[0].state).toBe('ready');
  f.ports.files.open=async()=>f.makeFile([1]);
  await expect(f.store.openAudio(track.reference)).rejects.toThrow('LOCAL_AUDIO_CORRUPT');
  expect((await f.store.list())[0].fileId).toBe(row.fileId);
});
it('a new instance/session for the same account reuses verified bytes without fetching', async()=>{
  const f=fixture(); await f.store.save(track,'audio/flac',3,input());
  const fetch=vi.fn(input());
  const same=new LocalDownloads(owner,f.ports);
  expect((await same.save(track,'audio/flac',3,fetch)).state).toBe('ready');
  expect(fetch).not.toHaveBeenCalled();
  expect(await new LocalDownloads(other,f.ports).list()).toEqual([]);
  expect((await new LocalDownloads(other,f.ports).reconcile()).records).toEqual([]);
});
it('legacy metadata upgrades preserve file identity, fingerprint, and source request count',async()=>{
  const f=fixture(),row=await f.store.save(track,'audio/flac',3,input());
  await f.store.updateMetadata([{...track,albumId:'album',artistId:'artist'}]);
  const updated=(await f.store.list())[0];expect(updated.fileId).toBe(row.fileId);
  expect(updated.fingerprint).toBe(row.fingerprint);expect(updated.track.albumId).toBe('album');expect(f.files.size).toBe(1);
  f.rows.clear();expect((await f.store.reconcile()).records[0].track.albumId).toBe('album');
});
it('checks queued plan validity under the storage lock before reuse or writing',async()=>{
  const f=fixture(),fetch=vi.fn(input());
  await expect(f.store.save(track,'audio/flac',3,fetch,undefined,async()=>{throw new Error('PLAN_CHANGED');})).rejects.toThrow('PLAN_CHANGED');
  expect(fetch).not.toHaveBeenCalled();expect(f.rows.size).toBe(0);
});
it('partial size never becomes ready and preserves an interrupted record', async()=>{
  const f=fixture(); await expect(f.store.save(track,'audio/flac',8,input())).rejects.toThrow('INVALID_LENGTH');
  expect((await f.store.list())[0].state).toBe('interrupted'); expect(f.manifests.size).toBe(0);
});
it('does not orphan bytes when retrying an interruption after file write',async()=>{
  const f=fixture(),hash=f.ports.fingerprint;
  f.ports.fingerprint=vi.fn().mockRejectedValueOnce(new DOMException('Interrupted','AbortError')).mockImplementation(hash);
  await expect(f.store.save(track,'audio/flac',3,input())).rejects.toThrow('Interrupted');
  expect(f.files.size).toBe(1);
  await f.store.save(track,'audio/flac',3,input());expect(f.files.size).toBe(1);
  await f.store.remove(track.reference);expect(f.files.size).toBe(0);
  expect((await f.store.reconcile()).unclaimed).toBe(0);
});
it('keeps cleanup recoverable if removal fails before a replacement',async()=>{
  const f=fixture();await expect(f.store.save(track,'audio/flac',8,input())).rejects.toThrow();
  const remove=f.ports.files.remove,fetch=vi.fn(input());
  f.ports.files.remove=vi.fn().mockRejectedValueOnce(new Error('Storage busy')).mockImplementation(remove);
  await expect(f.store.save(track,'audio/flac',3,fetch)).rejects.toThrow('Storage busy');
  expect(fetch).not.toHaveBeenCalled();expect((await f.store.list())[0].state).toBe('deleting');
  await f.store.reconcile();expect(f.files.size).toBe(0);
  await f.store.save(track,'audio/flac',3,fetch);expect(f.files.size).toBe(1);
});
it('recovers lost index from a verified manifest, not from an unclaimed file', async()=>{
  const f=fixture(); const row=await f.store.save(track,'audio/flac',3,input()); f.rows.clear();
  expect((await f.store.reconcile()).records[0]).toMatchObject({state:'ready',fileId:row.fileId});
  f.rows.clear(); f.manifests.clear();
  expect(await f.store.reconcile()).toEqual({records:[],unclaimed:1});
  expect(f.files.size).toBe(1);
});
it('recovers a crash after publishing manifest but before IDB ready commit', async()=>{
  const f=fixture(); const put=f.ports.index.put;
  f.ports.index.put=async row=>{ if(row.state==='ready') throw new Error('IDB temporarily unavailable'); await put(row); };
  await expect(f.store.save(track,'audio/flac',3,input())).rejects.toThrow();
  expect((await f.store.list())[0].state).toBe('writing');
  f.ports.index.put=put;
  expect((await f.store.reconcile()).records[0].state).toBe('ready');
});
it('retry after a published manifest reuses bytes without requiring an earlier reconciliation', async()=>{
  const f=fixture(); const put=f.ports.index.put;
  f.ports.index.put=async row=>{ if(row.state==='ready') throw new Error('Commit failed'); await put(row); };
  await expect(f.store.save(track,'audio/flac',3,input())).rejects.toThrow('Commit failed');
  f.ports.index.put=put;
  const fetch=vi.fn(input());
  expect((await new LocalDownloads(owner,f.ports).save(track,'audio/flac',3,fetch)).state).toBe('ready');
  expect(fetch).not.toHaveBeenCalled(); expect(f.files.size).toBe(1);
});
it('a quick check cannot clear a previous corruption diagnosis; a full audit can', async()=>{
  const f=fixture(); const row=await f.store.save(track,'audio/flac',3,input());
  f.files.set(f.key(owner,row.fileId),f.makeFile([3,2,1]));
  await f.store.check(track.reference,true);
  expect((await f.store.check(track.reference))?.state).toBe('corrupt');
  f.files.set(f.key(owner,row.fileId),f.makeFile([1,2,3]));
  expect((await f.store.check(track.reference))?.state).toBe('corrupt');
  expect((await f.store.check(track.reference,true))?.state).toBe('ready');
});
it('missing bytes and same-size damage are distinguished by full audit', async()=>{
  const f=fixture(); const row=await f.store.save(track,'audio/flac',3,input());
  f.files.set(f.key(owner,row.fileId),f.makeFile([3,2,1]));
  expect((await f.store.check(track.reference,true))?.state).toBe('corrupt');
  f.files.delete(f.key(owner,row.fileId));
  expect((await f.store.check(track.reference))?.state).toBe('missing');
  expect(f.manifests.size).toBe(1);
});
it('I/O/permission failure does not falsely label a download missing or remove it', async()=>{
  const f=fixture(); await f.store.save(track,'audio/flac',3,input());
  f.ports.files.open=async()=>{ throw new DOMException('Blocked','NotAllowedError'); };
  await expect(f.store.reconcile()).rejects.toThrow('Blocked');
  expect((await f.store.list())[0].state).toBe('ready'); expect(f.files.size).toBe(1);
});
it('insufficient space rejects before fetching without evicting anything', async()=>{
  const f=fixture(); const fetch=vi.fn(input());
  f.ports.space=async()=>{ throw new DOMException('Full','QuotaExceededError'); };
  await expect(f.store.save(track,'audio/flac',3,fetch)).rejects.toThrow('Full');
  expect(fetch).not.toHaveBeenCalled(); expect(f.rows.size).toBe(0);
});
it('quota failure during writing preserves prior good files and does not mark readiness', async()=>{
  const f=fixture(); await f.store.save(track,'audio/flac',3,input());
  f.ports.files.write=async()=>{ throw new DOMException('Full','QuotaExceededError'); };
  await expect(f.store.save({...track,reference:'bmV3'},'audio/flac',3,input())).rejects.toThrow('Full');
  expect((await f.store.list()).map(r=>r.state)).toEqual(['ready','interrupted']);
  expect(f.files.size).toBe(1);
});
it('cancellation and source failures cannot publish a ready manifest', async()=>{
  const f=fixture(); const controller=new AbortController(); controller.abort();
  const fetch=vi.fn(input());
  await expect(f.store.save(track,'audio/flac',3,fetch,controller.signal)).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
  await expect(f.store.save(track,'audio/flac',3,async()=>{throw new Error('Disconnected');})).rejects.toThrow();
  expect((await f.store.list())[0].state).toBe('interrupted'); expect(f.manifests.size).toBe(0);
});
it('rejects foreign manifests and invalid identifiers without touching paths', async()=>{
  const f=fixture(); const row=await f.store.save(track,'audio/flac',3,input()); f.rows.clear();
  f.manifests.set(f.key(owner,row.fileId),{...row,owner:other});
  expect(await f.store.reconcile()).toEqual({records:[],unclaimed:1});
  expect(()=>new LocalDownloads('../other',f.ports)).toThrow();
  expect(validRecord({...row,fileId:'../../file'},owner)).toBe(false);
});
it('refuses to choose between conflicting orphan versions after index loss', async()=>{
  const f=fixture(); const row=await f.store.save(track,'audio/flac',3,input());
  const duplicate={...row,fileId:f.ports.uuid()};
  f.files.set(f.key(owner,duplicate.fileId),f.makeFile([3,2,1]));
  f.manifests.set(f.key(owner,duplicate.fileId),duplicate); f.rows.clear();
  expect(await f.store.reconcile()).toEqual({records:[],unclaimed:2});
  expect(f.files.size).toBe(2);
});
it('validates the length and MIME received lazily without fetching an existing valid copy', async()=>{
  const f=fixture();
  const source=vi.fn(async()=>({body:await input()(),contentType:'audio/flac',expectedBytes:3}));
  const row=await f.store.save(track,'application/octet-stream',null,source);
  expect(row).toMatchObject({state:'ready',contentType:'audio/flac',bytes:3});
  await f.store.save(track,'application/octet-stream',null,source);
  expect(source).toHaveBeenCalledTimes(1);
});
it('rejects a truncated lazy source and never publishes it', async()=>{
  const f=fixture();
  await expect(f.store.save(track,'application/octet-stream',null,async()=>({
    body:await input()(),contentType:'audio/flac',expectedBytes:4,
  }))).rejects.toThrow('INVALID_LENGTH');
  expect(f.manifests.size).toBe(0);
});
it('explicit deletion leaves a tombstone, removes only this track, and permits explicit redownload', async()=>{
  const f=fixture();await f.store.save(track,'audio/flac',3,input());
  await f.store.save({...track,reference:'YW5vdGhlcg'},'audio/flac',3,input());
  await f.store.remove(track.reference);
  expect((await f.store.reconcile()).records.find(r=>r.track.reference===track.reference)?.state).toBe('deleted');
  expect(f.files.size).toBe(1);
  expect((await f.store.save(track,'audio/flac',3,input())).state).toBe('ready');
  expect(f.files.size).toBe(2);
});
it('resumes an interrupted explicit deletion instead of readopting its manifest', async()=>{
  const f=fixture();await f.store.save(track,'audio/flac',3,input());
  const remove=f.ports.files.remove;
  f.ports.files.remove=async()=>{throw new Error('Disk busy');};
  await expect(f.store.remove(track.reference)).rejects.toThrow('Disk busy');
  expect((await f.store.list())[0].state).toBe('deleting');
  f.ports.files.remove=remove;
  expect((await f.store.reconcile()).records[0].state).toBe('deleted');
  expect(f.files.size).toBe(0);
});
it('sidecars cannot revive a deleted or replaced original and remain isolated by account',async()=>{
  const f=fixture(),row=await f.store.save(track,'audio/flac',3,input());
  const write=vi.fn(async()=>undefined);f.ports.files.writeExtra=write;
  f.ports.files.readExtra=async()=>new Blob(['saved']);
  await f.store.saveExtra(track.reference,row.fileId,'lyrics',new Blob(['{}']),new AbortController().signal,()=>undefined);
  expect(write).toHaveBeenCalledOnce();
  expect(await new LocalDownloads(other,f.ports).readExtra(track.reference,'lyrics')).toBeNull();
  await f.store.remove(track.reference);
  await expect(f.store.saveExtra(track.reference,row.fileId,'lyrics',new Blob(['{}']),new AbortController().signal,()=>undefined)).rejects.toThrow('LOCAL_AUDIO_CHANGED');
  await f.store.save(track,'audio/flac',3,input());
  await expect(f.store.saveExtra(track.reference,row.fileId,'lyrics',new Blob(['{}']),new AbortController().signal,()=>undefined)).rejects.toThrow('LOCAL_AUDIO_CHANGED');
  expect(write).toHaveBeenCalledOnce();
});
it('sidecar permission/quota failures leave ready audio intact; cancellation before publish prevents writing',async()=>{
  const f=fixture(),row=await f.store.save(track,'audio/flac',3,input()),controller=new AbortController();
  const write=vi.fn(async()=>undefined);f.ports.files.writeExtra=write;
  f.ports.files.readExtra=async()=>{throw new DOMException('Denied','NotAllowedError');};
  await expect(f.store.readExtra(track.reference,'lyrics')).rejects.toThrow('Denied');
  f.ports.space=async()=>{controller.abort();};
  await expect(f.store.saveExtra(track.reference,row.fileId,'lyrics',new Blob(['{}']),controller.signal,()=>undefined)).rejects.toThrow();
  expect(write).not.toHaveBeenCalled();expect((await f.store.list())[0].state).toBe('ready');
});
