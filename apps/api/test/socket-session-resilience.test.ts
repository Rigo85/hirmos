import {afterEach,expect,it,vi} from 'vitest';
const state=vi.hoisted(()=>({connection:null as null|((socket:unknown)=>void)}));
vi.mock('socket.io',()=>({Server:class {
  engine={once:vi.fn()};sockets={sockets:new Map()};
  use(){} on(name:string,handler:(socket:unknown)=>void){if(name==='connection')state.connection=handler;}
}}));
import {createSocketServer} from '../src/socket/socket-server.js';

afterEach(()=>vi.useRealTimers());
it('drain joins pending socket work and refuses new work before storage closes',async()=>{
  vi.useFakeTimers();let finish!:(value:object)=>void;
  const handlers=new Map<string,(...args:unknown[])=>void>();
  const socket={id:'socket',connected:true,data:{userId:'user',sessionId:'session',deviceId:'device'},
    conn:{transport:{name:'synthetic'}},join:vi.fn(),emit:vi.fn(),disconnect:vi.fn(),
    once:(name:string,fn:(...args:unknown[])=>void)=>handlers.set(name,fn),on:(name:string,fn:(...args:unknown[])=>void)=>handlers.set(name,fn)};
  const snapshot=vi.fn(()=>new Promise(resolve=>finish=resolve)),authenticate=vi.fn();
  const io=createSocketServer({} as never,{PUBLIC_ORIGIN:'https://example.invalid'} as never,{authenticate} as never,{snapshot} as never);
  state.connection!(socket);while(!snapshot.mock.calls.length)await Promise.resolve();
  let stopped=false;const drain=io.drain().then(()=>{stopped=true;});await Promise.resolve();expect(stopped).toBe(false);
  handlers.get('playback:sync')!();await vi.advanceTimersByTimeAsync(15_000);expect(authenticate).not.toHaveBeenCalled();
  finish({});await drain;expect(stopped).toBe(true);handlers.get('disconnect')!('test');
});
it('keeps socket/session after transient auth storage error, retries, and still disconnects revoked access',async()=>{
  vi.useFakeTimers();const handlers=new Map<string,(...args:unknown[])=>void>();
  const socket={id:'socket',connected:true,data:{userId:'user',sessionId:'session',deviceId:'device',sessionToken:'synthetic'},
    conn:{transport:{name:'synthetic'}},join:vi.fn(),emit:vi.fn(),disconnect:vi.fn(),
    once:(name:string,fn:(...args:unknown[])=>void)=>handlers.set(name,fn),on:(name:string,fn:(...args:unknown[])=>void)=>handlers.set(name,fn)};
  const authenticate=vi.fn().mockRejectedValueOnce(new Error('PG unavailable')).mockResolvedValue({id:'session'});
  const snapshot=vi.fn(async()=>({})),logger={info:vi.fn(),warn:vi.fn(),error:vi.fn(),debug:vi.fn()};
  createSocketServer({} as never,{PUBLIC_ORIGIN:'https://example.invalid'} as never,{authenticate} as never,{snapshot} as never,undefined,logger);
  state.connection!(socket);await vi.advanceTimersByTimeAsync(15_000);
  expect(socket.disconnect).not.toHaveBeenCalled();expect(logger.warn).toHaveBeenCalled();
  expect(socket.emit).toHaveBeenCalledWith('playback:error',expect.objectContaining({code:'PLAYBACK_UNAVAILABLE'}));
  await vi.advanceTimersByTimeAsync(15_000);expect(authenticate).toHaveBeenCalledTimes(2);expect(socket.disconnect).not.toHaveBeenCalled();
  authenticate.mockRejectedValueOnce(new Error('PG unavailable'));handlers.get('playback:sync')!();await vi.advanceTimersByTimeAsync(0);
  expect(socket.disconnect).not.toHaveBeenCalled();
  authenticate.mockResolvedValue(null);await vi.advanceTimersByTimeAsync(15_000);
  expect(socket.disconnect).toHaveBeenCalledWith(true);
  expect(socket.emit).toHaveBeenCalledWith('playback:error',expect.objectContaining({code:'UNAUTHENTICATED'}));
  handlers.get('disconnect')!('test');
});
