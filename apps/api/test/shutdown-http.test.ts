import {expect,it} from 'vitest';
import Fastify from 'fastify';
import {Server} from 'socket.io';
import {drainBeforeClose} from '../src/shutdown.js';

it('drains real Fastify and Socket.IO sharing one HTTP server before closing storage',async()=>{
  const app=Fastify(),io=new Server(app.server);let closed=false;
  try {
    await app.listen({host:'127.0.0.1',port:0});
    await drainBeforeClose({
      stop:[()=>new Promise<void>(resolve=>{io.close(()=>resolve());}),()=>app.close()],
      close:async()=>{expect(app.server.listening).toBe(false);closed=true;},
      timedOut:()=>{throw new Error('shutdown timed out');},budgetMs:2000,
    });
    expect(closed).toBe(true);
  } finally {io.disconnectSockets(true);await app.close();}
});
