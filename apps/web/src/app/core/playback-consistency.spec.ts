import type { PlaybackSnapshot } from '@hirmos/contracts';
import { acceptsSnapshot, playbackAnchor, samePlaybackAnchor, PlaybackCommandSequencer } from './playback-consistency';

const snapshot = { sessionId: 'session', revision: 5, currentQueueItemId: 'item',
  playbackInstanceId: 'execution', leaseEpoch: 1 } as PlaybackSnapshot;

describe('playback consistency', () => {
  it('ignores an old ack arriving after a new broadcast', () => {
    expect(acceptsSnapshot(snapshot, { ...snapshot, revision: 4 })).toBe(false);
    expect(acceptsSnapshot(snapshot, { ...snapshot, revision: 6 })).toBe(true);
    expect(acceptsSnapshot(snapshot, snapshot)).toBe(true);
    expect(acceptsSnapshot(snapshot, { ...snapshot, sessionId: 'another' })).toBe(false);
    expect(acceptsSnapshot(null, snapshot)).toBe(true);
  });

  it('distinguishes queue item, execution and lease, not just the musical file', () => {
    const original = playbackAnchor(snapshot);
    expect(samePlaybackAnchor(original, playbackAnchor({ ...snapshot, revision: 6 }))).toBe(true);
    for (const changed of [{ currentQueueItemId: 'other' }, { playbackInstanceId: 'other' }, { leaseEpoch: 2 }]) {
      expect(samePlaybackAnchor(original, playbackAnchor({ ...snapshot, ...changed }))).toBe(false);
    }
  });

  it('serializes deliberate clicks without collapsing them or blocking after failure', async () => {
    const commands = new PlaybackCommandSequencer();
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const first = commands.run(async () => { order.push('first'); await gate; order.push('done'); });
    const failed = commands.run(async () => { order.push('failure'); throw new Error('expected'); });
    const failureCheck = expect(failed).rejects.toThrow('expected');
    const last = commands.run(async () => { order.push('last'); });
    await Promise.resolve();
    expect(order).toEqual(['first']);
    release();
    await Promise.all([first, failureCheck, last]);
    expect(order).toEqual(['first', 'done', 'failure', 'last']);
  });
});
