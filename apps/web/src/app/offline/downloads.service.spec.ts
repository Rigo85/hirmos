import { computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import type { PlaylistSummary, SessionResponse, Track } from '@hirmos/contracts';
import { SessionStore } from '../core/session.store';
import { PlaylistsService } from '../core/playlists.service';
import { DOWNLOAD_ENVIRONMENT, DownloadsService, type DownloadEnvironment } from './downloads.service';
import { LocalDownloads, type LocalDownload, type LocalPorts } from './local-downloads';
import type { DownloadPlan } from './download-plans';
import { DownloadFailure } from './download-transport';

const owner='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
const track=(id='one'):Track=>({id,title:id,artist:'Artist',album:'Album',albumId:'album',artistId:null,durationMs:1000,coverUrl:null,year:null,genres:[],favorite:false});
const sessionFor=(id:string):SessionResponse=>({user:{id,email:'test@example.test',displayName:'Test',role:'user'},expiresAt:'2026-12-01T00:00:00.000Z'});
function setup() {
  const session=signal<SessionResponse|null>(sessionFor(owner));
  const rows=new Map<string,LocalDownload>(),files=new Map<string,Blob>(),manifests=new Map<string,LocalDownload>(),plans=new Map<string,DownloadPlan>();
  const key=(owner:string,id:string)=>owner+'/'+id;
  const missing=()=>new DOMException('Missing','NotFoundError');
  const ports:LocalPorts={
    index:{get:async(o,r)=>rows.get(key(o,r)),list:async o=>[...rows.values()].filter(r=>r.owner===o),
      put:async row=>{rows.set(key(row.owner,row.track.reference),structuredClone(row));}},
    files:{write:async(o,id,body,signal)=>{const reader=body.getReader();let bytes=0;try{while(true){signal?.throwIfAborted();const r=await reader.read();if(r.done)break;bytes+=r.value.length;}}finally{await reader.cancel().catch(()=>undefined);}files.set(key(o,id),new Blob([new Uint8Array(bytes)]));return bytes;},
      open:async(o,id)=>{const file=files.get(key(o,id));if(!file)throw missing();return file;},
      manifest:async(o,id)=>{const row=manifests.get(key(o,id));if(!row)throw missing();return row;},
      publish:async row=>{manifests.set(key(row.owner,row.fileId),structuredClone(row));},
      ids:async o=>[...files.keys()].filter(k=>k.startsWith(o+'/')).map(k=>k.slice(o.length+1)),
      remove:async(o,id)=>{files.delete(key(o,id));manifests.delete(key(o,id));}},
    lock:async(_o,operation,signal)=>{signal?.throwIfAborted();return operation();},
    space:async()=>undefined,uuid:()=>crypto.randomUUID(),fingerprint:async()=>`sha256-chunks-v1:${'a'.repeat(64)}`,
  };
  const source=vi.fn(async()=>({body:new ReadableStream<Uint8Array>({start(c){c.enqueue(new Uint8Array([1,2,3]));c.close();}}),contentType:'audio/flac',expectedBytes:3}));
  const env:DownloadEnvironment={store:o=>new LocalDownloads(o,ports),source,
    plans:{list:async o=>[...plans.values()].filter(p=>p.owner===o),
      put:async p=>{plans.set(key(p.owner,p.id),structuredClone(p));},
      finish:async p=>{if(plans.get(key(p.owner,p.id))?.requestId===p.requestId)plans.set(key(p.owner,p.id),structuredClone(p));}}};
  const page=vi.fn();
  const localOwner=computed(()=>session()?.user.id??owner);
  const online=signal(true),canUseRemote=computed(()=>!!session()&&online());
  TestBed.configureTestingModule({providers:[{provide:SessionStore,useValue:{session,localOwner,canUseRemote,requireRenewal:()=>session.set(null)}},
    {provide:PlaylistsService,useValue:{page}},{provide:DOWNLOAD_ENVIRONMENT,useValue:env}]});
  const service=TestBed.inject(DownloadsService);TestBed.tick();
  return {service,session,online,rows,files,plans,source,page,env,ports};
}
async function idle(service:DownloadsService){await vi.waitFor(()=>{expect(service.loading()).toBe(false);expect(service.activePlan()).toBeNull();expect(service.queued()).toEqual([]);});}

it('favorites resolves all 5000 references in snapshot order, not just the visible page',async()=>{
  const f=setup(),refs=Array.from({length:5000},(_,i)=>'song'+i);
  f.env.favorites=vi.fn(async()=>refs);f.env.metadata=vi.fn(async (ids:string[])=>ids.map(id=>track(id)).reverse());
  f.source.mockRejectedValue(new DownloadFailure('HTTP_503'));
  await f.service.enqueueFavorites();await idle(f.service);
  expect(f.env.favorites).toHaveBeenCalledOnce();expect(f.env.metadata).toHaveBeenCalledTimes(100);
  expect(f.service.savedPlans()[0].tracks.map(t=>t.reference)).toEqual(refs);
  expect(f.service.savedPlans()[0].kind).toBe('favorites');expect(f.source).toHaveBeenCalledTimes(1);
});
it('favorites retains a durable selection on interruption and resumes without retransferring completed originals',async()=>{
  const f=setup();f.env.favorites=vi.fn(async()=>['one','two','three']);f.env.metadata=vi.fn(async (ids:string[])=>ids.map(id=>track(id)));
  const original=f.source.getMockImplementation()!;
  f.source.mockImplementationOnce(original).mockRejectedValueOnce(new DownloadFailure('HTTP_503'));
  await f.service.enqueueFavorites();await idle(f.service);
  expect(f.service.ready().size).toBe(1);expect(f.service.savedPlans()[0].tracks).toHaveLength(3);
  f.service.start(f.service.savedPlans()[0]);await idle(f.service);
  expect(f.source).toHaveBeenCalledTimes(4);expect(f.files.size).toBe(3);expect(f.service.ready().size).toBe(3);
});
it('favorite refresh retains unmarked tracks and removing its snapshot preserves independently saved files',async()=>{
  const f=setup();let refs=['one','two'];f.env.favorites=vi.fn(async()=>refs);f.env.metadata=vi.fn(async (ids:string[])=>ids.map(id=>track(id)));
  await f.service.enqueueFavorites();await idle(f.service);
  refs=['one'];expect(f.service.savedPlans()[0].tracks).toHaveLength(2); // no background favorite synchronization
  await f.service.enqueueFavorites();await idle(f.service);
  expect(f.source).toHaveBeenCalledTimes(2);expect(f.files.size).toBe(2);
  expect(f.service.savedPlans().some(p=>p.id==='track:two')).toBe(true);
  await f.service.removePlan(f.service.savedPlans().find(p=>p.kind==='favorites')!);
  expect([...f.service.ready()]).toEqual(['two']);
});
it.each(['empty','overflow','missing','duplicate','foreign'])('invalid %s favorite snapshot never replaces an existing plan or starts audio transfers',async reason=>{
  const f=setup();f.env.favorites=vi.fn(async()=>['one']);f.env.metadata=vi.fn(async (ids:string[])=>ids.map(id=>track(id)));
  await f.service.enqueueFavorites();await idle(f.service);const before=structuredClone(f.service.savedPlans());
  f.env.favorites=vi.fn(async()=>reason==='empty'?[]:reason==='overflow'?Array.from({length:5001},(_,i)=>'s'+i):reason==='duplicate'?['one','one']:['one','two']);
  if(reason==='missing')f.env.metadata=vi.fn(async()=>[track()]);
  if(reason==='foreign')f.env.metadata=vi.fn(async()=>[track(),track('foreign')]);
  await expect(f.service.enqueueFavorites()).rejects.toThrow();
  expect(f.service.savedPlans()).toEqual(before);expect(f.source).toHaveBeenCalledTimes(1);
});
it.each(['offline','expired','account','pause'] as const)('%s fences late favorite metadata before persisting a selection',async reason=>{
  const f=setup();f.env.favorites=vi.fn(async()=>['one']);let resolve!:(tracks:Track[])=>void,signal:AbortSignal|undefined;
  f.env.metadata=vi.fn((_ids,s)=>{signal=s;return new Promise<Track[]>(done=>resolve=done);});
  const work=f.service.enqueueFavorites();const failed=expect(work).rejects.toThrow();
  await vi.waitFor(()=>expect(f.env.metadata).toHaveBeenCalledOnce());
  if(reason==='offline')f.online.set(false);else if(reason==='expired')f.session.set(null);else if(reason==='account')f.session.set(sessionFor(other));else f.service.pause();
  TestBed.tick();expect(signal!.aborted).toBe(true);resolve([track()]);await failed;
  expect(f.plans.size).toBe(0);expect(f.source).not.toHaveBeenCalled();expect(f.service.favoritesBusy()).toBe(false);
});
it('cancellation during the storage read prevents publishing a favorite snapshot',async()=>{
  const f=setup();f.env.favorites=vi.fn(async()=>['one']);f.env.metadata=vi.fn(async()=>[track()]);await idle(f.service);
  const list=f.env.plans.list;f.env.plans.list=async o=>{const result=await list(o);f.service.pause();return result;};
  await expect(f.service.enqueueFavorites()).rejects.toThrow();expect(f.plans.size).toBe(0);expect(f.source).not.toHaveBeenCalled();
});
it('favorite preparation coalesces repeated clicks',async()=>{
  const f=setup();let resolve!:(refs:string[])=>void;f.env.favorites=vi.fn(()=>new Promise<string[]>(done=>resolve=done));f.env.metadata=vi.fn(async()=>[track()]);
  const work=f.service.enqueueFavorites();await vi.waitFor(()=>expect(f.env.favorites).toHaveBeenCalledOnce());
  await f.service.enqueueFavorites();resolve(['one']);await work;await idle(f.service);
  expect(f.env.favorites).toHaveBeenCalledOnce();expect(f.files.size).toBe(1);
});

it('prepares optional extras after all audio, and does not redownload originals for manual preparation',async()=>{
  const f=setup();const extras=vi.fn(async()=>{expect(f.source).toHaveBeenCalledTimes(2);});f.env.extras=extras;
  await f.service.enqueue([track(),track('two')],'album','album','Album');
  await vi.waitFor(()=>expect(extras).toHaveBeenCalledTimes(2));
  await vi.waitFor(()=>expect(f.service.extrasBusy()).toBe(false));
  await f.service.prepareAuxiliaries();expect(extras).toHaveBeenCalledTimes(4);
  expect(f.source).toHaveBeenCalledTimes(2);expect(f.service.ready().size).toBe(2);
});
it('an auxiliary outage preserves all audio and a repeated action respects Retry-After',async()=>{
  const f=setup();const extras=vi.fn(async()=>{throw new DownloadFailure('HTTP_429',Date.now()+120000);});f.env.extras=extras;
  await f.service.enqueue([track(),track('two')],'album','album','Album');
  await vi.waitFor(()=>expect(f.service.extrasIssue()).not.toBe(''));
  expect(f.service.ready().size).toBe(2);expect(extras).toHaveBeenCalledOnce();
  await f.service.prepareAuxiliaries();expect(extras).toHaveBeenCalledOnce();expect(f.service.extrasIssue()).toContain('esperar');
});
it('account changes abort auxiliary work and prevent starting the next row for a foreign account',async()=>{
  const f=setup();let pending:AbortSignal|undefined;
  const extras=vi.fn(async(_store,_row,signal:AbortSignal)=>{
    pending=signal;await new Promise<void>((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
  });f.env.extras=extras;
  await f.service.enqueue([track(),track('two')],'album','album','Album');
  await vi.waitFor(()=>expect(extras).toHaveBeenCalledOnce());
  f.session.set(sessionFor(other));TestBed.tick();
  await vi.waitFor(()=>expect(f.service.extrasBusy()).toBe(false));
  expect(pending?.aborted).toBe(true);expect(extras).toHaveBeenCalledOnce();expect(f.service.records()).toEqual([]);
});

it('album and individual plans reuse one physical copy and never involve playback',async()=>{
  const f=setup();await f.service.enqueue([track(),track('two')],'album','album','Album');await idle(f.service);
  expect(f.service.ready().size).toBe(2);
  await f.service.enqueue([track()]);await idle(f.service);
  expect(f.source).toHaveBeenCalledTimes(2);expect(f.files.size).toBe(2);expect(f.service.plans()).toHaveLength(2);
});
it('expiry/logout preserves visible local records; another account cannot readopt them',async()=>{
  const f=setup();await f.service.enqueue([track()]);await idle(f.service);
  f.session.set(null);TestBed.tick();expect(f.service.ready().has('one')).toBe(true);expect(f.files.size).toBe(1);
  f.session.set(sessionFor(other));TestBed.tick();await idle(f.service);expect(f.service.records()).toEqual([]);
  f.session.set(sessionFor(owner));TestBed.tick();await idle(f.service);expect(f.service.ready().has('one')).toBe(true);
  expect(f.source).toHaveBeenCalledTimes(1);
});
it('does not carry a multi-track selection into another account while saving plans',async()=>{
  const f=setup();const put=f.env.plans.put;
  f.env.plans.put=async plan=>{await put(plan);f.session.set(sessionFor(other));TestBed.tick();};
  await expect(f.service.enqueue([track(),track('two')])).rejects.toThrow('ACCOUNT_CHANGED');
  await idle(f.service);
  expect([...f.plans.values()].map(p=>[p.owner,p.sourceRef])).toEqual([[owner,'one']]);
  expect(f.source).not.toHaveBeenCalled();
});
it('stops a collection on service failure, preserves the snapshot and respects cooldown on retry',async()=>{
  const f=setup();f.source.mockRejectedValue(new DownloadFailure('HTTP_429',Date.now()+120000));
  await f.service.enqueue([track(),track('two')],'album','album','Album');await idle(f.service);
  expect(f.source).toHaveBeenCalledTimes(1);
  expect(f.service.plans()[0].lastIssue).toContain('esperar');
  f.service.start(f.service.plans()[0]);await idle(f.service);expect(f.source).toHaveBeenCalledTimes(1);
  await f.service.retry(f.service.records()[0]);await idle(f.service);expect(f.source).toHaveBeenCalledTimes(1);
});
it('physical deletion clears readiness and collection completion without deleting remote entities',async()=>{
  const f=setup();await f.service.enqueue([track(),track('two')],'album','album','Album');await idle(f.service);
  await f.service.remove('one');
  expect(f.files.size).toBe(1);expect(f.service.completed(f.service.plans()[0])).toBe(1);
  expect(f.service.ready().has('one')).toBe(false);expect(f.service.plans()[0].tracks).toHaveLength(2);
});
it('reconciles missing bytes rather than claiming a complete album',async()=>{
  const f=setup();await f.service.enqueue([track()],'album','album','Album');await idle(f.service);
  f.files.clear();await f.service.refresh();
  expect(f.service.records()[0].state).toBe('missing');expect(f.service.completed(f.service.plans()[0])).toBe(0);
});
it('materializes all playlist pages at the chosen revision, without a visible-page filter',async()=>{
  const f=setup();const summary={id:'playlist',revision:7,name:'List',count:101} as PlaylistSummary;
  f.page.mockImplementation(async(_id,offset,revision)=>({playlist:summary,items:Array.from({length:offset?1:100},(_,i)=>({track:track('song'+(offset+i)),availability:'available'})),nextOffset:offset?null:100}));
  // Halt at the first source to test the complete persisted snapshot, not 101 mock transfers.
  f.source.mockRejectedValue(new DownloadFailure('HTTP_503'));
  await f.service.enqueuePlaylist(summary);await idle(f.service);
  expect(f.page.mock.calls).toEqual([['playlist',0,7],['playlist',100,7]]);
  expect(f.service.plans()[0].tracks).toHaveLength(101);expect(f.source).toHaveBeenCalledTimes(1);
});
it('refuses a changing or incomplete playlist before writing any download plan',async()=>{
  const f=setup();const summary={id:'playlist',revision:7,name:'List',count:2} as PlaylistSummary;
  f.page.mockResolvedValue({playlist:{...summary,revision:8},items:[],nextOffset:null});
  await expect(f.service.enqueuePlaylist(summary)).rejects.toThrow();
  expect(f.plans.size).toBe(0);expect(f.source).not.toHaveBeenCalled();
});
it('aborts work at logout and prevents a late completion from repopulating the visible account',async()=>{
  const f=setup();
  f.source.mockImplementation((...args:unknown[])=>new Promise((_resolve,reject)=>{
    const signal=args[2] as AbortSignal;signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
  }));
  await f.service.enqueue([track(),track('two')],'album','album','Album');
  await vi.waitFor(()=>expect(f.source).toHaveBeenCalledTimes(1));
  f.session.set(null);TestBed.tick();await idle(f.service);
  expect(f.service.ready().size).toBe(0);expect(f.service.plans()).toHaveLength(1);expect(f.source).toHaveBeenCalledTimes(1);
});
it('removing one selection retains shared files and individual saves, then releases only exclusive bytes',async()=>{
  const f=setup();await f.service.enqueue([track(),track('two')],'album','album','Album');await idle(f.service);
  await f.service.enqueue([track()]);await idle(f.service);
  const album=f.service.savedPlans().find(p=>p.kind==='album')!;
  expect(f.service.exclusiveReferences(album)).toEqual(['two']);
  await f.service.removePlan(album);
  expect(f.service.savedPlans()).toHaveLength(1);expect(f.files.size).toBe(1);
  expect([...f.service.ready()]).toEqual(['one']);
  await f.service.removePlan(f.service.savedPlans()[0]);expect(f.files.size).toBe(0);
});
it('a stale queued selection cannot recreate a removed download',async()=>{
  const f=setup();await f.service.enqueue([track()],'album','album','Album');await idle(f.service);
  const stale=f.service.savedPlans()[0];await f.service.removePlan(stale);
  f.service.start(stale);await idle(f.service);
  expect(f.files.size).toBe(0);expect(f.source).toHaveBeenCalledTimes(1);
});
it('a persisted removal resumes after interruption without deleting another selection',async()=>{
  const f=setup();await f.service.enqueue([track(),track('two')],'album','album','Album');await idle(f.service);
  await f.service.enqueue([track()]);await idle(f.service);
  const plan=f.service.savedPlans().find(p=>p.kind==='album')!,remove=f.ports.files.remove;
  f.ports.files.remove=async()=>{throw new Error('disk interrupted');};
  await expect(f.service.removePlan(plan)).rejects.toThrow('disk interrupted');
  expect([...f.plans.values()].find(p=>p.id===plan.id)?.removal).toBe('removing');
  f.ports.files.remove=remove;await f.service.refresh();await idle(f.service);
  expect([...f.service.ready()]).toEqual(['one']);expect(f.files.size).toBe(1);
  expect(f.service.savedPlans()).toHaveLength(1);
});
it('refreshing a snapshot keeps removed tracks as independent downloads',async()=>{
  const f=setup();await f.service.enqueue([track(),track('two')],'album','album','Album');await idle(f.service);
  await f.service.enqueue([track()],'album','album','Album');await idle(f.service);
  expect(f.service.savedPlans().find(p=>p.id==='track:two')).toBeDefined();
  await f.service.removePlan(f.service.savedPlans().find(p=>p.kind==='album')!);
  expect([...f.service.ready()]).toEqual(['two']);
});
it('metadata upgrade changes no audio bytes and accepts only requested references',async()=>{
  const f=setup();await f.service.enqueue([track()]);await idle(f.service);
  const row=[...f.rows.values()][0];delete row.track.albumId;delete row.track.artistId;
  f.env.metadata=vi.fn(async()=>[track(),track('foreign')]);
  await f.service.refresh();await f.service.updateLegacyMetadata();
  expect(f.service.legacyCount()).toBe(0);expect(f.files.size).toBe(1);expect(f.source).toHaveBeenCalledTimes(1);
  expect(f.service.records()[0].track.albumId).toBe('album');
});
it.each(['offline','expired','account','pause'] as const)('%s fences a late metadata response without changing saved records',async reason=>{
  const f=setup();await f.service.enqueue([track()]);await idle(f.service);
  const row=[...f.rows.values()][0];delete row.track.albumId;await f.service.refresh();
  let resolve!:(tracks:Track[])=>void,pending:AbortSignal|undefined;
  f.env.metadata=vi.fn((_refs,signal)=>{pending=signal;return new Promise<Track[]>(done=>resolve=done);});
  const work=f.service.updateLegacyMetadata();await vi.waitFor(()=>expect(f.env.metadata).toHaveBeenCalledOnce());
  if(reason==='offline')f.online.set(false);
  else if(reason==='expired')f.session.set(null);
  else if(reason==='account')f.session.set(sessionFor(other));
  else f.service.pause();
  TestBed.tick();expect(pending?.aborted).toBe(true);
  resolve([{...track(),title:'Late online title'}]);await work;await idle(f.service);
  expect([...f.rows.values()][0].track.title).toBe('one');expect([...f.rows.values()][0].track.albumId).toBeUndefined();
  if(reason!=='account')expect(f.service.legacyCount()).toBe(1);
  expect(f.files.size).toBe(1);expect(f.source).toHaveBeenCalledOnce();expect(f.service.error()).toBe('');
  expect(f.service.metadataBusy()).toBe(false);
  if(reason==='offline'){
    f.online.set(true);TestBed.tick();expect(f.env.metadata).toHaveBeenCalledOnce();
    f.env.metadata=vi.fn(async()=>[track()]);await f.service.updateLegacyMetadata();
    expect(f.service.legacyCount()).toBe(0);expect(f.source).toHaveBeenCalledOnce();
  }
});
it('metadata cancellation while reading the index prevents publication',async()=>{
  const f=setup();await f.service.enqueue([track()]);await idle(f.service);
  const row=[...f.rows.values()][0];delete row.track.albumId;await f.service.refresh();
  f.env.metadata=vi.fn(async()=>[{...track(),title:'Late online title'}]);
  const get=f.ports.index.get;
  f.ports.index.get=async(o,r)=>{const record=await get(o,r);f.service.pause();return record;};
  await f.service.updateLegacyMetadata();
  expect([...f.rows.values()][0].track.albumId).toBeUndefined();
  expect([...f.rows.values()][0].track.title).toBe('one');expect(f.service.error()).toBe('');
});
it('a late metadata rejection after going offline is silent and preserves downloads',async()=>{
  const f=setup();await f.service.enqueue([track()]);await idle(f.service);
  const row=[...f.rows.values()][0];delete row.track.albumId;await f.service.refresh();
  let reject!:(error:Error)=>void;
  f.env.metadata=vi.fn(()=>new Promise<Track[]>((_done,fail)=>reject=fail));
  const work=f.service.updateLegacyMetadata();await vi.waitFor(()=>expect(f.env.metadata).toHaveBeenCalledOnce());
  f.online.set(false);TestBed.tick();reject(new Error('HTTP_503'));await work;
  expect(f.service.error()).toBe('');expect(f.service.metadataBusy()).toBe(false);
  expect(f.service.ready().size).toBe(1);expect(f.files.size).toBe(1);
});
it('the real metadata transport cancels HttpClient and refuses an already cancelled request',async()=>{
  TestBed.configureTestingModule({providers:[provideHttpClient(),provideHttpClientTesting()]});
  const env=TestBed.inject(DOWNLOAD_ENVIRONMENT),http=TestBed.inject(HttpTestingController),controller=new AbortController();
  const request=env.metadata!(['one'],controller.signal),rejected=expect(request).rejects.toThrow();
  const pending=http.expectOne('/api/music/tracks/resolve');controller.abort();await rejected;
  expect(pending.cancelled).toBe(true);
  expect(()=>env.metadata!(['one'],controller.signal)).toThrow();http.verify();
});
it('favorite transport asserts the owner, rejects a foreign response and cancels pending HTTP',async()=>{
  TestBed.configureTestingModule({providers:[provideHttpClient(),provideHttpClientTesting()]});
  const env=TestBed.inject(DOWNLOAD_ENVIRONMENT),http=TestBed.inject(HttpTestingController),controller=new AbortController();
  const wrong=env.favorites!(owner,controller.signal),rejected=expect(wrong).rejects.toThrow('ACCOUNT_CHANGED');
  const request=http.expectOne('/api/library/favorites/download-selection');expect(request.request.headers.get('x-hirmos-account-id')).toBe(owner);
  request.flush({references:['one']},{headers:{'x-hirmos-account-id':other}});await rejected;
  const work=env.favorites!(owner,controller.signal),aborted=expect(work).rejects.toThrow();
  const pending=http.expectOne('/api/library/favorites/download-selection');controller.abort();await aborted;expect(pending.cancelled).toBe(true);
  await expect(env.favorites!(owner,controller.signal)).rejects.toThrow();http.verify();
});
it('deletion with an old account context fails instead of deleting the new account file',async()=>{
  const f=setup();await f.service.enqueue([track()]);await idle(f.service);
  f.session.set(sessionFor(other));TestBed.tick();await idle(f.service);
  await expect(f.service.remove('one',owner)).rejects.toThrow('ACCOUNT_CHANGED');expect(f.files.size).toBe(1);
});
it('partial metadata resolution publishes successful updates without retransferring audio',async()=>{
  const f=setup();await f.service.enqueue([track(),track('two')]);await idle(f.service);
  for(const row of f.rows.values())delete row.track.albumId;
  f.env.metadata=vi.fn(async()=>[track()]);
  await f.service.refresh();await f.service.updateLegacyMetadata();
  expect(f.service.legacyCount()).toBe(1);
  expect(f.service.records().find(r=>r.track.reference==='one')?.track.albumId).toBe('album');
  expect(f.service.error()).not.toBe('');
  expect(f.files.size).toBe(2);expect(f.source).toHaveBeenCalledTimes(2);
});
