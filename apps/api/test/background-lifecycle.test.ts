import {afterEach,expect,it,vi} from 'vitest';
import {CacheMaintenanceWorker} from '../src/cache/cache-maintenance-worker.js';
import {LyricsCacheBackfillWorker} from '../src/cache/lyrics-cache-backfill-worker.js';
import {CatalogSyncCoordinator} from '../src/cache/catalog-sync-coordinator.js';
import {CatalogSyncWorker} from '../src/cache/catalog-sync-worker.js';
import {drainBeforeClose} from '../src/shutdown.js';

const logger={info:vi.fn(),warn:vi.fn()};
afterEach(()=>{vi.useRealTimers();vi.clearAllMocks();});
it('maintenance waits for an active inventory and stops before deleting objects',async()=>{
  let finish!:(refs:Set<string>)=>void;
  const repo={referencedHashes:()=>new Promise<Set<string>>(resolve=>finish=resolve),withMaintenance:vi.fn()};
  const store={inventory:async function*(){yield {hash:'synthetic',byteLength:1};}};
  const worker=new CacheMaintenanceWorker(repo as never,store as never,logger as never,100);
  const running=worker.run();let stopped=false;const stop=worker.stop().then(()=>{stopped=true;});
  await Promise.resolve();expect(stopped).toBe(false);finish(new Set());await Promise.all([running,stop]);
  expect(repo.withMaintenance).not.toHaveBeenCalled();
});
it('lyrics backfill retries transient errors but stops scheduling after shutdown',async()=>{
  vi.useFakeTimers();const repo={withoutRawObject:vi.fn().mockRejectedValueOnce(new Error('PG unavailable')).mockResolvedValue([])};
  const worker=new LyricsCacheBackfillWorker(repo as never,{} as never,logger);worker.start();
  await vi.advanceTimersByTimeAsync(30_000);expect(logger.warn).toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(35_000);expect(repo.withoutRawObject).toHaveBeenCalledTimes(2);
  await worker.stop();await vi.advanceTimersByTimeAsync(1_000_000);expect(repo.withoutRawObject).toHaveBeenCalledTimes(2);
});
it('lyrics backfill completes the current publish/attach before releasing storage',async()=>{
  let finish!:(value:{key:string;parserVersion:number})=>void;
  const repo={withoutRawObject:vi.fn(async()=>[{sourceId:'s',remoteTrackId:'t',provider:'p',fingerprint:'f',document:{}}]),attachRawObject:vi.fn(async()=>{})};
  const cache={put:vi.fn(()=>new Promise(resolve=>finish=resolve))};
  const worker=new LyricsCacheBackfillWorker(repo as never,cache as never,logger),running=worker.run();
  while(!cache.put.mock.calls.length)await Promise.resolve();let stopped=false;const stop=worker.stop().then(()=>{stopped=true;});
  await Promise.resolve();expect(stopped).toBe(false);finish({key:'key',parserVersion:1});await Promise.all([running,stop]);
  expect(repo.attachRawObject).toHaveBeenCalledOnce();expect(repo.withoutRawObject).toHaveBeenCalledOnce();
});
it('catalog shutdown waits for manually started work and rejects new triggers',async()=>{
  let finish!:(value:never)=>void;
  const coordinator=new CatalogSyncCoordinator({syncCatalog:()=>new Promise(resolve=>finish=resolve)} as never);
  const running=coordinator.trigger().completion;let stopped=false;
  const stop=coordinator.stop().then(()=>{stopped=true;});await Promise.resolve();expect(stopped).toBe(false);
  expect(()=>coordinator.trigger()).toThrow('shutting down');finish({artists:1,albums:1,tracks:1} as never);
  await Promise.all([running,stop]);expect(stopped).toBe(true);
});
it('catalog worker catches synchronous trigger failure and can poll again',async()=>{
  vi.useFakeTimers();const trigger=vi.fn().mockImplementationOnce(()=>{throw new Error('busy');})
    .mockReturnValue({started:true,completion:Promise.resolve({counts:{},followUpError:null})});
  const worker=new CatalogSyncWorker({trigger} as never,logger,60_000);worker.start();
  await vi.advanceTimersByTimeAsync(10_000);expect(logger.warn).toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(50_000);expect(trigger).toHaveBeenCalledTimes(2);await worker.stop();
});
it('shutdown drains all producers before closing storage',async()=>{
  let finish!:()=>void;const close=vi.fn(async()=>{}),timedOut=vi.fn();
  const stopping=drainBeforeClose({stop:[()=>new Promise<void>(resolve=>finish=resolve)],close,timedOut,budgetMs:1000});
  await Promise.resolve();expect(close).not.toHaveBeenCalled();finish();await stopping;
  expect(close).toHaveBeenCalledOnce();expect(timedOut).not.toHaveBeenCalled();
});
it('shutdown timeout signals termination without closing storage under active work',async()=>{
  vi.useFakeTimers();let finish!:()=>void;const close=vi.fn(async()=>{}),timedOut=vi.fn();
  const stopping=drainBeforeClose({stop:[()=>new Promise<void>(resolve=>finish=resolve)],close,timedOut,budgetMs:8000});
  await vi.advanceTimersByTimeAsync(8000);expect(timedOut).toHaveBeenCalledOnce();expect(close).not.toHaveBeenCalled();
  finish();await stopping;
});
it('shutdown drains other producers even when one stop fails',async()=>{
  let finish!:()=>void;const close=vi.fn(async()=>{});
  const stopping=drainBeforeClose({stop:[()=>{throw new Error('synthetic');},()=>new Promise<void>(resolve=>finish=resolve)],close,timedOut:vi.fn(),budgetMs:1000});
  const result=expect(stopping).rejects.toThrow('synthetic');finish();await result;expect(close).not.toHaveBeenCalled();
});
