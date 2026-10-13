import {ListenMeter} from './listen-meter';
import {offlineListenSchema,type OfflineListen} from '@hirmos/contracts';

const execution={id:'11111111-1111-4111-8111-111111111111',reference:'source_track',startedAt:'2026-10-12T23:59:58.000Z'};
const start=Date.parse(execution.startedAt);
it('counts position advancement, not pauses, stalls or seek jumps',()=>{
  const rows:OfflineListen[]=[];const meter=new ListenMeter(r=>rows.push(r));meter.start(execution,0,0,start);
  meter.sample(2000,2000,start+2000);meter.sample(2000,7000,start+7000);
  meter.sample(42000,8000,start+8000); // unannounced forward jump is discarded too
  meter.rebase(1000,9000,start+9000);meter.sample(3000,11000,start+11000);
  expect(rows.reduce((sum,r)=>sum+r.heardMs,0)).toBe(4000);
  expect(rows.every(r=>offlineListenSchema.safeParse(r).success)).toBe(true);
});
it('splits midnight and long background advancement into bounded UTC-day chunks',()=>{
  const rows:OfflineListen[]=[];const meter=new ListenMeter(r=>rows.push(r));meter.start(execution,0,0,start);
  meter.sample(125000,125000,start+125000);
  expect(rows.map(r=>r.heardMs)).toEqual([2000,60000,60000,3000]);
  expect(rows[0].at).toBe('2026-10-12T23:59:59.999Z');
  expect(rows[1].at.slice(0,10)).toBe('2026-10-13');
  expect(rows.every(r=>offlineListenSchema.safeParse(r).success)).toBe(true);
  expect(new Set(rows.map(r=>r.id)).size).toBe(4);
});
it('rejects clock discontinuity, rebases cold resumes and clears old executions',()=>{
  const emit=vi.fn(),meter=new ListenMeter(emit);meter.start(execution,42000,0,start);
  meter.sample(43000,1000,start-20000);expect(emit).not.toHaveBeenCalled();
  meter.sample(45000,3000,start-18000);expect(emit).not.toHaveBeenCalled();
  meter.start(execution,45000,3000,start);meter.sample(46000,4000,start+1000);expect(emit).toHaveBeenCalledOnce();
  meter.clear();meter.sample(47000,5000,start+2000);expect(emit).toHaveBeenCalledOnce();
});
