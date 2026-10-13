import {afterEach,expect,it,vi} from 'vitest';
import {ImageWarmWorker} from '../src/cache/image-warm-worker.js';
import {MetadataWarmWorker} from '../src/cache/metadata-warm-worker.js';
import {TopSongsWorker} from '../src/cache/top-songs-worker.js';

afterEach(()=>vi.useRealTimers());
for(const [Worker,method,interval] of [
  [ImageWarmWorker,'enqueueCatalogImages',900_000],
  [MetadataWarmWorker,'enqueueStaleArtists',3_600_000],
  [TopSongsWorker,'enqueueDue',3_600_000],
] as const){
  it(`${Worker.name} catches periodic rejection and can enqueue again`,async()=>{
    vi.useFakeTimers();
    const enqueue=vi.fn().mockResolvedValue(0),logger={info:vi.fn(),warn:vi.fn()};
    const repo={[method]:enqueue,claim:vi.fn(async()=>null)};
    const worker=new Worker(repo as never,{} as never,logger);worker.start();
    await vi.advanceTimersByTimeAsync(interval-1);enqueue.mockRejectedValueOnce(new Error('Synthetic PG outage'));
    await vi.advanceTimersByTimeAsync(1);expect(logger.warn).toHaveBeenCalledWith({err:expect.any(Error)},expect.stringContaining('enqueue failed'));
    await worker.enqueueNow();await worker.stop();
  });
  it(`${Worker.name} coalesces enqueues and waits for them on stop`,async()=>{
    vi.useFakeTimers();let finish!:(count:number)=>void;
    const enqueue=vi.fn(()=>new Promise<number>(resolve=>finish=resolve));
    const worker=new Worker({[method]:enqueue} as never,{} as never,{info:vi.fn(),warn:vi.fn()});worker.start();
    const first=worker.enqueueNow(),second=worker.enqueueNow();let stopped=false;
    const stopping=worker.stop().then(()=>{stopped=true;});await Promise.resolve();
    expect(stopped).toBe(false);expect(enqueue).toHaveBeenCalledTimes(1);
    finish(0);await Promise.all([first,second,stopping]);expect(stopped).toBe(true);
    await worker.enqueueNow();expect(enqueue).toHaveBeenCalledTimes(1);
  });
}
