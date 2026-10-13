import type {FastifyInstance} from 'fastify';
import {offlineListenBatchSchema} from '@hirmos/contracts';
import type {Database} from '../db/database.js';
import {requireAuthentication} from './auth-routes.js';
import {RateLimiter} from '../auth/rate-limiter.js';
import {importOfflineListens} from '../activity/offline-listens.js';

export async function registerOfflineListenRoutes(app:FastifyInstance,db?:Database):Promise<void>{
  const limiter=new RateLimiter();
  app.post('/api/activity/offline',{bodyLimit:128*1024},async(request,reply)=>{
    reply.header('cache-control','no-store');const denied=requireAuthentication(request,reply);if(denied)return denied;
    const user=request.authSession!.response.user.id;
    // Cookies can change in another tab while a batch waits. This is an
    // assertion, never the source of identity/authorization.
    if(request.headers['x-hirmos-account-id']!==user)return reply.code(409).send({code:'ACCOUNT_CHANGED'});
    const parsed=offlineListenBatchSchema.safeParse(request.body);
    if(!parsed.success)return reply.code(400).send({code:'INVALID_OFFLINE_REPORT'});
    const rate=limiter.take('offline-listens',user,30,60_000);
    if(!rate.allowed)return reply.code(429).header('retry-after',rate.retryAfterSeconds).send({code:'REPORT_BUSY'});
    if(!db?.transaction)return reply.code(503).send({code:'REPORT_UNAVAILABLE'});
    try{
      const result=await importOfflineListens(db,user,parsed.data.reports);
      request.log.info({offlineReport:{accepted:result.accepted.length,rejected:result.rejected.length}},'Offline listening report processed');
      return result;
    }catch{
      request.log.warn({offlineReport:{outcome:'retry'}},'Offline listening report not confirmed');
      return reply.code(503).send({code:'REPORT_UNAVAILABLE'});
    }
  });
}
