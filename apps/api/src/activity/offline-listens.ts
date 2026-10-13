import type {OfflineListen,OfflineListenAck} from '@hirmos/contracts';
import type {Database} from '../db/database.js';
import {decodeTrackReference} from '../music-source/track-reference.js';
import {ActivityRepository} from './activity-repository.js';

export async function importOfflineListens(db:Database,userId:string,reports:OfflineListen[],now=Date.now()):Promise<OfflineListenAck>{
  if(!db.transaction)throw new Error('Offline listening import requires a transaction');
  return db.transaction(async connection=>{
    await connection.query("SET LOCAL statement_timeout = '3s'");
    await connection.query("SET LOCAL lock_timeout = '1s'");
    const deadline=Date.now()+7000;
    // Serializes receipt + execution + aggregates for this account only.
    await connection.query("SELECT pg_advisory_xact_lock(hashtext('offline-listens'),hashtext($1))",[userId]);
    const result:OfflineListenAck={accepted:[],rejected:[]};
    for(const report of reports){
      if(Date.now()>deadline)throw new Error('Offline report transaction budget exceeded');
      const reject=(code:OfflineListenAck['rejected'][number]['code'])=>result.rejected.push({id:report.id,code});
      const reference=decodeTrackReference(report.reference);
      if(!reference||! /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(reference.sourceId)){reject('INVALID_REFERENCE');continue;}
      if(Date.parse(report.startedAt)<Date.UTC(2000,0,1)||Date.parse(report.at)>now+300_000){reject('INVALID_TIME');continue;}
      const receipt=await connection.query<{same:boolean}>(
        'SELECT payload = $3::jsonb AS same FROM offline_listen_receipts WHERE user_id=$1 AND id=$2',
        [userId,report.id,JSON.stringify(report)]);
      if(receipt.rows.length){if(receipt.rows[0]!.same)result.accepted.push(report.id);else reject('ID_CONFLICT');continue;}
      const track=await connection.query('SELECT 1 FROM catalog_tracks WHERE source_id=$1 AND remote_track_id=$2',
        [reference.sourceId,reference.remoteId]);
      if(!track.rows.length){reject('UNKNOWN_TRACK');continue;}
      const execution=await connection.query<{source_id:string;remote_track_id:string;started_at:Date}>(
        'SELECT source_id,remote_track_id,started_at FROM offline_listen_executions WHERE user_id=$1 AND id=$2',
        [userId,report.executionId]);
      const old=execution.rows[0];
      if(old&&(old.source_id!==reference.sourceId||old.remote_track_id!==reference.remoteId||old.started_at.getTime()!==Date.parse(report.startedAt))){
        reject('ID_CONFLICT');continue;
      }
      const activity=new ActivityRepository({...connection,close:async()=>{}});
      if(!old){
        await connection.query('INSERT INTO offline_listen_executions(user_id,id,source_id,remote_track_id,started_at) VALUES($1,$2,$3,$4,$5)',
          [userId,report.executionId,reference.sourceId,reference.remoteId,report.startedAt]);
        await activity.recordOffline(userId,reference.sourceId,reference.remoteId,new Date(report.startedAt),0,true);
      }
      await connection.query('INSERT INTO offline_listen_receipts(user_id,id,execution_id,payload) VALUES($1,$2,$3,$4::jsonb)',
        [userId,report.id,report.executionId,JSON.stringify(report)]);
      await activity.recordOffline(userId,reference.sourceId,reference.remoteId,new Date(report.at),report.heardMs,false);
      result.accepted.push(report.id);
    }
    return result;
  });
}
