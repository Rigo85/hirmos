import {signal} from '@angular/core';
import {TestBed} from '@angular/core/testing';
import {HttpErrorResponse,HttpHeaders} from '@angular/common/http';
import type {OfflineListen} from '@hirmos/contracts';
import {SessionStore} from '../core/session.store';
import {LISTEN_OUTBOX,LISTEN_TRANSPORT,OfflineListenRecorder,OfflineListenSender} from './offline-listens.service';

const owner='11111111-1111-4111-8111-111111111111';
const report:OfflineListen={id:crypto.randomUUID(),executionId:crypto.randomUUID(),reference:'reference',
  startedAt:'2026-10-12T00:00:00.000Z',at:'2026-10-12T00:00:05.000Z',heardMs:5000};
function setup(){
  const online=signal(false),account=signal<string|null>(owner);let generation=0;
  const rows=[{owner,id:report.id,report,retryAt:0}];
  const outbox={put:vi.fn(async()=>{}),batch:vi.fn(async()=>rows),
    acknowledge:vi.fn(async(_owner:string,_ids:string[],_ack:unknown,_now:number)=>{rows.splice(0);}),
    defer:vi.fn(async(_owner:string,_ids:string[],_until:number,_blocked?:string)=>{}),cooldown:vi.fn(async()=>{})};
  const transport={send:vi.fn(async()=>({accepted:[report.id],rejected:[]}))};
  vi.stubGlobal('navigator',{locks:{request:vi.fn(async(_name:string,_options:unknown,fn:Function)=>fn({}))}});
  TestBed.configureTestingModule({providers:[{provide:SessionStore,useValue:{canUseRemote:online,localOwner:account,requestGeneration:()=>generation}},
    {provide:LISTEN_OUTBOX,useValue:outbox},{provide:LISTEN_TRANSPORT,useValue:transport}]});
  const sender=TestBed.inject(OfflineListenSender);TestBed.tick();
  return {sender,outbox,transport,online,account,expire:()=>generation++};
}
afterEach(()=>{TestBed.resetTestingModule();vi.unstubAllGlobals();});
it('island never reads/sends reports even with network available; explicit online sends and ACKs',async()=>{
  const f=setup();await f.sender.flush();expect(f.outbox.batch).not.toHaveBeenCalled();
  f.online.set(true);await f.sender.flush();
  expect(f.transport.send).toHaveBeenCalledWith(owner,[report],expect.any(AbortSignal));
  expect(f.outbox.acknowledge).toHaveBeenCalledOnce();
});
it('rechecks mode after asynchronous storage read before issuing HTTP',async()=>{
  const f=setup();let release!:(value:any)=>void;f.outbox.batch.mockImplementationOnce(()=>new Promise(r=>release=r));
  f.online.set(true);const pending=f.sender.flush();await Promise.resolve();f.online.set(false);
  release([{owner,id:report.id,report,retryAt:0}]);await pending;
  expect(f.transport.send).not.toHaveBeenCalled();
});
it('does not consume an ACK received after account or generation changes',async()=>{
  const f=setup();let release!:(value:any)=>void;f.transport.send.mockImplementationOnce(()=>new Promise(r=>release=r));
  f.online.set(true);const pending=f.sender.flush();while(!release)await Promise.resolve();
  f.account.set('another');f.expire();release({accepted:[report.id],rejected:[]});await pending;
  expect(f.outbox.acknowledge).not.toHaveBeenCalled();
});
it('persists Retry-After and retains identical report IDs when confirmation is lost',async()=>{
  const f=setup();f.transport.send.mockRejectedValueOnce(new HttpErrorResponse({status:429,headers:new HttpHeaders({'retry-after':'120'})}));
  f.online.set(true);const before=Date.now();await f.sender.flush();
  expect(f.outbox.acknowledge).not.toHaveBeenCalled();expect(f.outbox.defer.mock.calls[0][2]).toBeGreaterThanOrEqual(before+120000);
  await f.sender.flush();expect(f.transport.send).toHaveBeenCalledOnce();
});
it('does not delete any data for malformed or incomplete ACKs',async()=>{
  const f=setup();f.transport.send.mockResolvedValueOnce({accepted:[],rejected:[]});f.online.set(true);await f.sender.flush();
  expect(f.outbox.acknowledge).not.toHaveBeenCalled();expect(f.outbox.defer).toHaveBeenCalled();
});
it('retains failed local writes for a bounded-memory retry with the exact same ID',async()=>{
  const f=setup(),recorder=TestBed.inject(OfflineListenRecorder);
  f.outbox.put.mockRejectedValueOnce(new Error('QUOTA'));recorder.record(owner,report);
  await vi.waitFor(()=>expect(recorder.error()).toContain('guardar'));
  await recorder.flush();expect(f.outbox.put).toHaveBeenNthCalledWith(2,owner,report);expect(recorder.error()).toBe('');
});
