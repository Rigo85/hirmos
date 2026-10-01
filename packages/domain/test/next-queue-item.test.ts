import { describe, expect, it } from 'vitest';
import { nextQueueItem, previousQueueItem } from '../src/index.js';

const queue = ['c','a','b','a'].map((trackRef,i) => ({ id: String(i), trackRef }));
describe('authoritative next queue entry', () => {
  it('previous restarts after three seconds and otherwise follows visible order', () => {
    expect(previousQueueItem(queue,'2',{positionMs:3000})?.id).toBe('2');
    expect(previousQueueItem(queue,'2',{positionMs:2999})?.id).toBe('1');
    expect(previousQueueItem(queue,'0',{positionMs:0})?.id).toBe('0');
    expect(previousQueueItem(queue,'0',{positionMs:0,repeat:'one'})?.id).toBe('0');
    expect(previousQueueItem(queue,'0',{positionMs:0,repeat:'all'})?.id).toBe('3');
  });
  it('previous skips omitted recordings with a bounded traversal', () => {
    expect(previousQueueItem(queue,'0',{positionMs:0,repeat:'all',omitted:['a']})?.id).toBe('2');
    expect(previousQueueItem(queue,'0',{positionMs:0,repeat:'all',omitted:['a','b','c']})).toBeNull();
    expect(previousQueueItem([],null,{positionMs:0})).toBeNull();
  });
  it('uses the existing order, including a previously shuffled queue', () => {
    expect(nextQueueItem(queue,'0')?.trackRef).toBe('a');
  });
  it('temporarily omits all occurrences of a failed recording without changing the queue', () => {
    expect(nextQueueItem(queue,'0',{omitted:['a'],failed:true})?.trackRef).toBe('b');
    expect(queue).toHaveLength(4);
  });
  it('never loops repeat-one on a failed track', () => {
    expect(nextQueueItem(queue,'0',{repeat:'one'})?.id).toBe('0');
    expect(nextQueueItem(queue,'0',{repeat:'one',failed:true})?.id).toBe('1');
  });
  it('wraps repeat-all only to an eligible entry and ends when everything is omitted', () => {
    expect(nextQueueItem(queue,'3',{repeat:'all',failed:true,omitted:['a']})?.id).toBe('0');
    expect(nextQueueItem(queue,'3',{repeat:'all',failed:true,omitted:['a','b','c']})).toBeNull();
    expect(nextQueueItem(queue,'3')).toBeNull();
  });
});
