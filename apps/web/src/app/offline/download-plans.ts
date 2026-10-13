import { checkOwner, type LocalTrack, validRecord } from './local-downloads';
import { downloadIndex } from './browser-download-storage';

export const DOWNLOAD_NAMESPACE = 'hirmos-downloads-v1';
export interface DownloadPlan {
  version: 1;
  owner: string;
  id: string;
  kind: 'track' | 'album' | 'playlist' | 'favorites';
  title: string;
  sourceRef: string;
  revision: number | null;
  createdAt: string;
  requestId: string;
  tracks: LocalTrack[];
  lastIssue?: string;
  failedReference?: string;
  retryAt?: number;
  removal?: 'removing' | 'removed';
}
export function validPlan(value: unknown, owner: string): value is DownloadPlan {
  if (!value || typeof value !== 'object') return false;
  const p = value as DownloadPlan;
  return p.version === 1 && p.owner === owner && ['track','album','playlist','favorites'].includes(p.kind)
    && (p.kind!=='favorites'||p.sourceRef==='favorites')
    && (p.removal===undefined || p.removal==='removing' || p.removal==='removed')
    && typeof p.id === 'string' && p.id === `${p.kind}:${p.sourceRef}`
    && typeof p.sourceRef === 'string' && /^[A-Za-z0-9_-]{1,2048}$/.test(p.sourceRef)
    && typeof p.title === 'string' && p.title.length > 0 && p.title.length <= 1024
    && (p.revision === null || (Number.isSafeInteger(p.revision) && p.revision >= 0))
    && typeof p.createdAt === 'string' && Number.isFinite(Date.parse(p.createdAt))
    && typeof p.requestId === 'string' && /^[a-f0-9-]{36}$/i.test(p.requestId)
    && (p.lastIssue === undefined || (typeof p.lastIssue === 'string' && p.lastIssue.length <= 500))
    && (p.failedReference === undefined || (typeof p.failedReference === 'string' && /^[A-Za-z0-9_-]{1,2048}$/.test(p.failedReference)))
    && (p.retryAt === undefined || (Number.isFinite(p.retryAt) && p.retryAt >= 0))
    && Array.isArray(p.tracks) && p.tracks.length > 0 && p.tracks.length <= 5000
    && new Set(p.tracks.map(t=>t?.reference)).size === p.tracks.length
    && p.tracks.every(track => validRecord({version:1,owner,track,
      fileId:'00000000-0000-4000-8000-000000000000',state:'writing',bytes:0,
      fingerprint:null,contentType:'application/octet-stream',savedAt:p.createdAt}, owner));
}
export interface PlanIndex {
  list(owner: string): Promise<DownloadPlan[]>;
  put(plan: DownloadPlan): Promise<void>;
  finish(plan: DownloadPlan): Promise<void>;
}
export const browserPlans: PlanIndex = {
  async finish(plan) {
    if (!validPlan(plan,plan.owner)) throw new Error('INVALID_PLAN');
    await downloadIndex(DOWNLOAD_NAMESPACE,'readwrite',store=>{
      const request=store.get([plan.owner,plan.id]);
      request.onsuccess=()=>{
        if(request.result?.requestId===plan.requestId && !request.result.removal)store.put({...request.result,lastIssue:plan.lastIssue,retryAt:plan.retryAt,failedReference:plan.failedReference});
      };
      return request;
    },'plans');
  },
  async list(owner) {
    checkOwner(owner);
    const rows = await downloadIndex<DownloadPlan[]>(DOWNLOAD_NAMESPACE,'readonly',s=>
      s.getAll(IDBKeyRange.bound([owner,''],[owner,'\uffff'])), 'plans');
    if (rows.some(row=>!validPlan(row,owner))) throw new Error('INVALID_PLAN');
    return rows;
  },
  async put(plan) {
    checkOwner(plan.owner);
    if (!validPlan(plan,plan.owner)) throw new Error('INVALID_PLAN');
    await downloadIndex(DOWNLOAD_NAMESPACE,'readwrite',s=>s.put(plan),'plans');
  },
};
