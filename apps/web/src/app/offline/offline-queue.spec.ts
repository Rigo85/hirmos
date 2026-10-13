import {editOfflineQueue,offlineUpcoming,emptyOfflineQueue,nextOfflineReference,readOfflineQueue,shuffledReferences} from './offline-queue';
const owner='owner';
const queue=()=>({...emptyOfflineQueue(owner),queue:['a','b','c'],order:['a','b','c'],current:'a'});
it('reads old queues additively without a database migration',()=>{
  const {revision,pastCount,...legacy}=queue();expect(readOfflineQueue(legacy,owner)).toEqual(queue());
});
it('appends unique identities without autoplay and applies the 5000 limit after deduplication',()=>{
  const prepared=editOfflineQueue(emptyOfflineQueue(owner),{action:'append',references:['a','b','a']});
  expect(prepared.current).toBeNull();expect(prepared.order).toEqual(['a','b']);
  expect(editOfflineQueue(prepared,{action:'append',references:['b','a']})).toBe(prepared);
  const full=editOfflineQueue(emptyOfflineQueue(owner),{action:'append',references:Array.from({length:5000},(_,n)=>`r${n}`)});
  expect(editOfflineQueue(full,{action:'append',references:['r0']})).toBe(full);
  expect(()=>editOfflineQueue(full,{action:'append',references:['new']})).toThrow('QUEUE_LIMIT');
});
it('moves only upcoming tracks, keeps their relative order and does not change current position',()=>{
  const s={...queue(),queue:['a','b','c','d'],order:['a','b','c','d'],positionMs:42000};
  const moved=editOfflineQueue(s,{action:'move',references:['d','c'],before:'b'});
  expect(moved.order).toEqual(['a','c','d','b']);expect(moved.positionMs).toBe(42000);expect(moved.current).toBe('a');
  expect(()=>editOfflineQueue(s,{action:'move',references:['a'],before:'b'})).toThrow('QUEUE_CHANGED');
});
it('clearing upcoming preserves current and previous; removing last current never resurrects history',()=>{
  const s={...queue(),current:'b',positionMs:42000};
  const cleared=editOfflineQueue(s,{action:'clear-upcoming'});
  expect(cleared.order).toEqual(['a','b']);expect(cleared.positionMs).toBe(42000);
  const removed=editOfflineQueue(cleared,{action:'remove',references:['b']});
  expect(removed.current).toBeNull();expect(removed.positionMs).toBe(0);expect(removed.pastCount).toBe(1);
  expect(offlineUpcoming(removed)).toEqual([]);
  const appended=editOfflineQueue(removed,{action:'append',references:['c']});
  expect(nextOfflineReference(appended,1)).toBe('c');expect(offlineUpcoming(appended)).toEqual(['c']);
  expect(editOfflineQueue(removed,{action:'remove',references:['a']})).toEqual({...emptyOfflineQueue(owner),revision:3});
});
it('removing current chooses next surviving entry, not repeat-one or a removed item',()=>{
  const s={...queue(),repeat:'one' as const};
  expect(editOfflineQueue(s,{action:'remove',references:['a','b']}).current).toBe('c');
});
it('validates isolated persisted queue state and rejects malformed permutations/duplicates',()=>{
  expect(readOfflineQueue(queue(),owner)).toEqual(queue());
  for(const raw of [null,{}, {...queue(),owner:'other'}, {...queue(),queue:['a','a','c']},
    {...queue(),order:['a','x','c']},{...queue(),current:'foreign'},{...queue(),positionMs:NaN},
    {...queue(),queue:Array.from({length:5001},(_,i)=>String(i))}])expect(readOfflineQueue(raw,owner)).toBeNull();
});
it('repeat one affects natural ending, never a manual next',()=>{
  const state={...queue(),repeat:'one' as const};
  expect(nextOfflineReference(state,1,true)).toBe('a');
  expect(nextOfflineReference(state,1)).toBe('b');
  expect(nextOfflineReference({...state,current:'c'},1)).toBeNull();
});
it('repeat all wraps and prepared queue starts with the first ordered item',()=>{
  expect(nextOfflineReference({...queue(),current:'c',repeat:'all'},1,true)).toBe('a');
  expect(nextOfflineReference({...queue(),repeat:'all'},-1)).toBe('c');
  expect(nextOfflineReference({...queue(),current:null},1)).toBe('a');
});
it('shuffle keeps each reference exactly once and retains the current track',()=>{
  for(let i=0;i<20;i++){const refs=shuffledReferences(['a','b','c'],'b');expect(refs[0]).toBe('b');expect([...refs].sort()).toEqual(['a','b','c']);}
});
