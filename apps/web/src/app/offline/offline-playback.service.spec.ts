import {signal} from '@angular/core';
import {TestBed} from '@angular/core/testing';
import type {Track} from '@hirmos/contracts';
import {AudioPlayerService} from '../core/audio-player.service';
import {MediaSessionService} from '../core/media-session.service';
import {SessionStore} from '../core/session.store';
import {OFFLINE_PLAYBACK_ENVIRONMENT,OfflinePlaybackService} from './offline-playback.service';
import {emptyOfflineQueue,type OfflineQueue} from './offline-queue';
import type {LocalDownload,LocalTrack} from './local-downloads';
import {OfflineListenRecorder} from './offline-listens.service';

const owner='11111111-1111-4111-8111-111111111111';
const tracks:LocalTrack[]=['a','b','c','d'].map(reference=>({reference,title:reference,artist:'Synthetic',album:'Test',durationMs:180000}));
function setup(saved:OfflineQueue|null=null){
  const localOwner=signal(owner),offline=signal(true),release=vi.fn();
  let stored=saved;
  const callbacks:{ended?:()=>void;failed?:(message:string,failure:{code:string})=>void;started?:()=>void}={};
  const audio={track:signal<Track|null>(null),positionSeconds:signal(0),durationSeconds:signal(180),playing:signal(false),requested:signal(false),
    load:vi.fn((track:Track)=>audio.track.set(track)),
    resume:vi.fn(async()=>{audio.requested.set(true);audio.playing.set(true);}),
    pause:vi.fn(()=>{audio.requested.set(false);audio.playing.set(false);}),
    clear:vi.fn(()=>{audio.track.set(null);audio.positionSeconds.set(0);audio.pause();}),
    seek:vi.fn((s:number)=>audio.positionSeconds.set(s)),
    onEnded:vi.fn(fn=>callbacks.ended=fn),onPlaybackFailed:vi.fn(fn=>callbacks.failed=fn),onPlaybackStarted:vi.fn(fn=>callbacks.started=fn)};
  const open=vi.fn(async(reference:string)=>({record:{track:tracks.find(t=>t.reference===reference)!} as LocalDownload,file:new Blob(['synthetic'])}));
  const env={files:vi.fn(()=>({openAudio:open})),read:vi.fn(async()=>stored),save:vi.fn(async(s:OfflineQueue)=>{stored=structuredClone(s);}),
    claim:vi.fn(async():Promise<(()=>void)|null>=>release),url:vi.fn(()=>`blob:synthetic-${crypto.randomUUID()}`),revoke:vi.fn()};
  const media={registerHandlers:vi.fn(),synchronize:vi.fn(),clear:vi.fn()};
  const listens={record:vi.fn(),error:signal('')};
  TestBed.configureTestingModule({providers:[OfflinePlaybackService,{provide:AudioPlayerService,useValue:audio},
    {provide:MediaSessionService,useValue:media},{provide:SessionStore,useValue:{local:{offline},localOwner,session:signal(null)}},
    {provide:OFFLINE_PLAYBACK_ENVIRONMENT,useValue:env},{provide:OfflineListenRecorder,useValue:listens}]});
  const service=TestBed.inject(OfflinePlaybackService);TestBed.tick();
  return {service,audio,open,env,media,callbacks,offline,localOwner,release,listens};
}
afterEach(()=>{TestBed.resetTestingModule();vi.restoreAllMocks();});
it('records real progress but not seeks, and preserves execution across pause/resume',async()=>{
  let mono=0;const wall=Date.now();vi.spyOn(performance,'now').mockImplementation(()=>mono);vi.spyOn(Date,'now').mockImplementation(()=>wall+mono);
  const f=setup();await f.service.play(tracks,'a');const execution=f.service.state().listenExecution!.id;
  mono=5000;f.audio.positionSeconds.set(5);f.service.checkpoint();
  expect(f.listens.record).toHaveBeenCalledOnce();expect(f.listens.record.mock.calls[0][1].heardMs).toBe(5000);
  f.service.seek(42);f.service.pause();mono=15000;await f.service.toggle();
  mono=20000;f.audio.positionSeconds.set(47);f.service.checkpoint();
  expect(f.listens.record).toHaveBeenCalledTimes(2);expect(f.service.state().listenExecution!.id).toBe(execution);
  await f.service.next(true);expect(f.service.state().listenExecution!.id).not.toBe(execution);
});
it('cold resume retains execution identity so reopening does not count a second start',async()=>{
  const execution={id:crypto.randomUUID(),reference:'a',startedAt:'2026-10-12T00:00:00.000Z'};
  const f=setup({...emptyOfflineQueue(owner),queue:['a'],order:['a'],current:'a',positionMs:42000,listenExecution:execution});
  await f.service.toggle();expect(f.service.state().listenExecution).toEqual(execution);
  await f.service.repeat();await f.service.repeat();await f.service.next(true);
  expect(f.service.state().listenExecution!.id).not.toBe(execution.id);
});
it('a pause during delayed ownership cancels the pending play before it opens audio',async()=>{
  const f=setup();let release!:(value:()=>void)=>void;
  f.env.claim.mockImplementationOnce(()=>new Promise(resolve=>release=resolve));
  const pending=f.service.play(tracks,'a');while(!f.env.claim.mock.calls.length)await Promise.resolve();
  f.service.pause();release(f.release);await pending;
  expect(f.open).not.toHaveBeenCalled();expect(f.audio.requested()).toBe(false);
  await f.service.play(tracks,'b');expect(f.audio.track()?.id).toBe('b');
});
it('only the newest selection survives delayed ownership',async()=>{
  const f=setup();let release!:(value:()=>void)=>void;
  f.env.claim.mockImplementationOnce(()=>new Promise(resolve=>release=resolve));
  const first=f.service.play(tracks,'a');while(!f.env.claim.mock.calls.length)await Promise.resolve();
  const second=f.service.play(tracks,'b');release(f.release);await Promise.all([first,second]);
  expect(f.open).toHaveBeenCalledTimes(1);expect(f.audio.track()?.id).toBe('b');
});
it('a pause wins over an already queued next or ended transition',async()=>{
  const f=setup();await f.service.play(tracks,'a');f.open.mockClear();
  const pending=f.service.next(true);f.service.pause();await pending;
  expect(f.open).not.toHaveBeenCalled();expect(f.audio.requested()).toBe(false);expect(f.service.state().current).toBe('a');
});
it('preserves two deliberate next commands but ignores a duplicate ended transition',async()=>{
  const f=setup();await f.service.play(tracks,'a');
  await Promise.all([f.service.next(),f.service.next()]);expect(f.service.state().current).toBe('c');
  await f.service.play(tracks,'a');await Promise.all([f.service.next(true),f.service.next(true)]);
  expect(f.service.state().current).toBe('b');
});
it('prepares a unique queue without audio, then explicit play starts it',async()=>{
  const f=setup();await f.service.edit({action:'append',references:['a','b','a']});
  expect(f.service.state().order).toEqual(['a','b']);expect(f.audio.resume).not.toHaveBeenCalled();
  await f.service.toggle();expect(f.service.state().current).toBe('a');
});
it('moves, removes and appends future songs without reopening audio or losing position',async()=>{
  const f=setup();await f.service.play(tracks,'a');f.audio.positionSeconds.set(42);f.open.mockClear();f.audio.clear.mockClear();
  await f.service.edit({action:'move',references:['d'],before:'b'});
  await f.service.edit({action:'remove',references:['b']});await f.service.edit({action:'append',references:['b','a']});
  expect(f.service.state().order).toEqual(['a','d','c','b']);expect(f.service.state().positionMs).toBe(42000);
  expect(f.audio.requested()).toBe(true);expect(f.open).not.toHaveBeenCalled();expect(f.audio.clear).not.toHaveBeenCalled();
});
it('removing a paused current remains paused and no empty queue leaves a ghost track',async()=>{
  const f=setup();await f.service.play(tracks,'a');f.service.pause();f.open.mockClear();
  await f.service.edit({action:'remove',references:['a']});
  expect(f.service.state().current).toBe('b');expect(f.open).not.toHaveBeenCalled();expect(f.audio.track()).toBeNull();
  await f.service.edit({action:'remove',references:['b','c','d']});await f.service.toggle();
  expect(f.service.state().queue).toEqual([]);expect(f.audio.track()).toBeNull();expect(f.audio.requested()).toBe(false);
});
it('removing a playing current advances, removing final current stops even in repeat-all',async()=>{
  const f=setup();await f.service.play(tracks,'c');await f.service.repeat();
  await f.service.edit({action:'remove',references:['c']});expect(f.audio.track()?.id).toBe('d');
  await f.service.edit({action:'remove',references:['d']});expect(f.audio.track()).toBeNull();expect(f.audio.requested()).toBe(false);
  expect(f.service.state().pastCount).toBe(2);expect(f.service.state().current).toBeNull();
  await f.service.edit({action:'append',references:['c']});await f.service.toggle();expect(f.audio.track()?.id).toBe('c');
});
it('rejects stale confirmation after track change; checkpoints alone do not invalidate it',async()=>{
  const f=setup();await f.service.play(tracks,'a');const version=f.service.state().revision;
  f.service.checkpoint();expect(f.service.state().revision).toBe(version);
  await f.service.next(true);expect(await f.service.edit({action:'clear-upcoming'},version)).toBe(false);
  expect(f.service.state().order).toEqual(['a','b','c','d']);expect(f.service.error()).toContain('La cola cambió');
});
it('queue row selection preserves the queue and toggles current without reloading',async()=>{
  const f=setup();await f.service.play(tracks,'a');await f.service.select('c',f.service.state().revision);
  expect(f.service.state().queue).toEqual(['a','b','c','d']);expect(f.audio.track()?.id).toBe('c');
  f.open.mockClear();await f.service.select('c',f.service.state().revision);
  expect(f.audio.requested()).toBe(false);expect(f.open).not.toHaveBeenCalled();
});
it('removing a currently opening track fences its late bytes',async()=>{
  const f=setup();let resolve!:(result:{record:LocalDownload;file:Blob})=>void;
  f.open.mockImplementationOnce(()=>new Promise(done=>resolve=done));
  const pending=f.service.play(tracks,'a');while(!f.open.mock.calls.length)await Promise.resolve();
  await f.service.edit({action:'remove',references:['a']});expect(f.audio.track()?.id).toBe('b');
  resolve({record:{track:tracks[0]} as LocalDownload,file:new Blob(['late'])});await pending;
  expect(f.audio.track()?.id).toBe('b');expect(f.env.url).toHaveBeenCalledOnce();
});
it('plays original local bytes, seeks and advances without any remote dependency',async()=>{
  const f=setup();await f.service.play(tracks,'a');
  expect(f.open).toHaveBeenCalledWith('a',expect.any(AbortSignal));
  expect(f.audio.load).toHaveBeenCalledWith(expect.objectContaining({id:'a',coverUrl:null}),expect.stringMatching(/^blob:/));
  f.service.seek(42);expect(f.audio.positionSeconds()).toBe(42);
  await f.service.next();expect(f.service.state().current).toBe('b');expect(f.audio.requested()).toBe(true);
  f.service.pause();expect(f.audio.requested()).toBe(false);
  await f.service.toggle();expect(f.audio.requested()).toBe(true);expect(f.open).toHaveBeenCalledTimes(2);
});
it('restores the per-account queue paused and resumes only on explicit play',async()=>{
  const saved={...emptyOfflineQueue(owner),queue:['a','b'],order:['a','b'],current:'b',positionMs:42000};
  const f=setup(saved);await Promise.resolve();
  expect(f.audio.resume).not.toHaveBeenCalled();expect(f.service.state().current).toBe('b');
  await f.service.play(tracks,'b');expect(f.audio.positionSeconds()).toBe(42);expect(f.audio.track()?.id).toBe('b');
});
it('session expiry does not stop local audio; a changed local owner does',async()=>{
  const f=setup();await f.service.play(tracks,'a');f.audio.pause.mockClear();
  TestBed.tick();expect(f.audio.pause).not.toHaveBeenCalled(); // session is already null
  f.localOwner.set('22222222-2222-4222-8222-222222222222');TestBed.tick();
  expect(f.audio.track()).toBeNull();expect(f.service.owns()).toBe(false);
});
it('rejects another tab ownership without opening a file',async()=>{
  const f=setup();f.env.claim.mockResolvedValue(null);
  await f.service.play(tracks,'a');expect(f.service.error()).toContain('Otra pestaña');expect(f.open).not.toHaveBeenCalled();
});
it('late file opens after stop cannot restart audio or leak a Blob URL',async()=>{
  const f=setup();let resolve!:(result:{record:LocalDownload;file:Blob})=>void;
  f.open.mockImplementationOnce(()=>new Promise(done=>resolve=done));
  const pending=f.service.play(tracks,'a');
  while(!f.open.mock.calls.length)await Promise.resolve();
  f.service.stop();resolve({record:{track:tracks[0]} as LocalDownload,file:new Blob(['late'])});await pending;
  expect(f.audio.resume).not.toHaveBeenCalled();expect(f.env.url).not.toHaveBeenCalled();
});
it('a pause while the local file is opening cannot become delayed autoplay',async()=>{
  const f=setup();let resolve!:(result:{record:LocalDownload;file:Blob})=>void;
  f.open.mockImplementationOnce(()=>new Promise(done=>resolve=done));
  const pending=f.service.play(tracks,'a');while(!f.open.mock.calls.length)await Promise.resolve();
  f.service.pause();resolve({record:{track:tracks[0]} as LocalDownload,file:new Blob(['late'])});await pending;
  expect(f.audio.resume).not.toHaveBeenCalled();expect(f.service.opening()).toBe(false);
});
it('skips missing files in current shuffle order with a bounded three-track circuit',async()=>{
  const state={...emptyOfflineQueue(owner),queue:['a','b','c','d'],order:['c','a','d','b'],current:'c',repeat:'one' as const,shuffled:true};
  const f=setup(state);f.open.mockRejectedValue(new Error('LOCAL_AUDIO_MISSING'));
  await f.service.toggle();expect(f.open.mock.calls.map(c=>c[0])).toEqual(['c','a','d']);
  expect(f.service.error()).toContain('tres archivos');expect(f.audio.requested()).toBe(false);
  expect(f.service.inventoryRevision()).toBe(3);
});
it('I/O failure is not silently treated as a missing song',async()=>{
  const f=setup();f.open.mockRejectedValue(new DOMException('No permission','NotAllowedError'));
  await f.service.play(tracks,'a');expect(f.open).toHaveBeenCalledTimes(1);expect(f.service.inventoryRevision()).toBe(0);
  expect(f.service.error()).toContain('No pudimos abrir');
});
it('repeat-one advances manually, while natural end repeats the current track',async()=>{
  const f=setup();await f.service.play(tracks,'a');await f.service.repeat();await f.service.repeat();
  await f.service.next(true);expect(f.service.state().current).toBe('a');
  await f.service.next();expect(f.service.state().current).toBe('b');expect(f.service.state().repeat).toBe('one');
  await f.service.shuffle();await f.service.play(tracks,'d');
  expect(f.service.state().repeat).toBe('one');expect(f.service.state().shuffled).toBe(true);
});
it('stopping checkpoints before releasing ownership and revokes the opened URL',async()=>{
  const f=setup();await f.service.play(tracks,'a');f.audio.positionSeconds.set(42);f.service.stop();
  await new Promise(resolve=>setTimeout(resolve,0));
  expect(f.env.save).toHaveBeenLastCalledWith(expect.objectContaining({current:'a',positionMs:42000}));
  expect(f.release).toHaveBeenCalledOnce();expect(f.env.revoke).toHaveBeenCalledOnce();expect(f.audio.track()).toBeNull();
});
it('Media Session play is idempotent, not a pause toggle',async()=>{
  const f=setup();await f.service.play(tracks,'a');f.audio.pause.mockClear();
  f.media.registerHandlers.mock.calls[0][0].play();expect(f.audio.pause).not.toHaveBeenCalled();
});
