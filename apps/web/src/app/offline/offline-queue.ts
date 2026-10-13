import type {ListenExecution} from './listen-meter';
export interface OfflineQueue {
  version:1; owner:string; queue:string[]; order:string[]; current:string|null;
  positionMs:number; repeat:'off'|'all'|'one'; shuffled:boolean;
  revision:number; pastCount:number;
  listenExecution?:ListenExecution;
}
export const emptyOfflineQueue=(owner:string):OfflineQueue=>({version:1,owner,queue:[],order:[],current:null,positionMs:0,repeat:'off',shuffled:false,revision:0,pastCount:0});
export function readOfflineQueue(value:unknown,owner:string):OfflineQueue|null {
  const s=value as OfflineQueue|null;
  if(!s||s.version!==1||s.owner!==owner||!Array.isArray(s.queue)||!Array.isArray(s.order)
    ||s.queue.length>5000||s.order.length!==s.queue.length||typeof s.shuffled!=='boolean'
    ||!['off','all','one'].includes(s.repeat)||!Number.isSafeInteger(s.positionMs)||s.positionMs<0||s.positionMs>86400000)return null;
  const refs=new Set(s.queue);
  if(refs.size!==s.queue.length||s.queue.some(r=>typeof r!=='string'||!/^[A-Za-z0-9_-]{1,2048}$/.test(r))
    ||new Set(s.order).size!==refs.size||s.order.some(r=>!refs.has(r))||(s.current!==null&&!refs.has(s.current)))return null;
  const revision=s.revision??0,pastCount=s.pastCount??0;
  if(!Number.isSafeInteger(revision)||revision<0||!Number.isSafeInteger(pastCount)||pastCount<0||pastCount>s.queue.length)return null;
  const execution=s.listenExecution;
  const listenExecution=execution&&execution.reference===s.current&&/^[a-f0-9-]{36}$/i.test(execution.id)
    &&typeof execution.startedAt==='string'&&Number.isFinite(Date.parse(execution.startedAt))?execution:undefined;
  return {version:1,owner,queue:[...s.queue],order:[...s.order],current:s.current,positionMs:s.positionMs,repeat:s.repeat,shuffled:s.shuffled,revision,pastCount,
    ...(listenExecution?{listenExecution}:{} )};
}
export function nextOfflineReference(state:OfflineQueue,direction:1|-1,ended=false):string|null {
  if(!state.order.length)return null;
  if(ended&&state.repeat==='one'&&state.current)return state.current;
  const index=state.current===null?state.pastCount-1:state.order.indexOf(state.current),next=index+direction;
  if(next>=0&&next<state.order.length)return state.order[next];
  return state.repeat==='all'?state.order[direction===1?0:state.order.length-1]:null;
}

export const offlinePastCount=(s:OfflineQueue)=>s.current===null?s.pastCount:s.order.indexOf(s.current);
export const offlineUpcoming=(s:OfflineQueue)=>s.order.slice(s.current===null?s.pastCount:offlinePastCount(s)+1);
export type OfflineQueueEdit={action:'append';references:string[]}|{action:'remove';references:string[]}
  |{action:'move';references:string[];before:string|null}|{action:'clear-upcoming'};
/** Pure, unique queue edits. Identity is the source/track reference, never a title. */
export function editOfflineQueue(s:OfflineQueue,edit:OfflineQueueEdit):OfflineQueue {
  let queue=[...s.queue],order=[...s.order],current=s.current,positionMs=s.positionMs,pastCount=s.pastCount;
  if(edit.action==='append'){
    const existing=new Set(queue),added=[...new Set(edit.references)].filter(r=>!existing.has(r));
    if(queue.length+added.length>5000)throw new Error('QUEUE_LIMIT');
    queue.push(...added);order.push(...added);
  }else if(edit.action==='move'){
    const upcoming=new Set(offlineUpcoming(s)),picked=new Set(edit.references);
    if(!picked.size||[...picked].some(r=>!upcoming.has(r))||edit.before!==null&&(!upcoming.has(edit.before)||picked.has(edit.before)))throw new Error('QUEUE_CHANGED');
    const moving=order.filter(r=>picked.has(r));order=order.filter(r=>!picked.has(r));
    order.splice(edit.before===null?order.length:order.indexOf(edit.before),0,...moving);
    // Manual order becomes the base for subsequently disabling shuffle.
    queue=[...order];
  }else{
    const remove=new Set(edit.action==='clear-upcoming'?offlineUpcoming(s):edit.references);
    queue=queue.filter(r=>!remove.has(r));order=order.filter(r=>!remove.has(r));
    pastCount=s.order.slice(0,offlinePastCount(s)).filter(r=>!remove.has(r)).length;
    if(current&&remove.has(current)){current=offlineUpcoming(s).find(r=>!remove.has(r))??null;positionMs=0;}
  }
  if(!queue.length){current=null;positionMs=0;pastCount=0;}
  if(queue.join('\0')===s.queue.join('\0')&&order.join('\0')===s.order.join('\0')&&current===s.current)return s;
  const result={...s,queue,order,current,positionMs,pastCount,revision:s.revision+1};
  if(current!==s.current)delete result.listenExecution;
  if(!readOfflineQueue(result,s.owner))throw new Error('INVALID_QUEUE');
  return result;
}
export function shuffledReferences(refs:string[],current:string|null):string[] {
  const order=refs.filter(r=>r!==current);
  for(let i=order.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[order[i],order[j]]=[order[j],order[i]];}
  return current?[current,...order]:order;
}
