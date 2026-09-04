import type { PlaybackSnapshot } from '@hirmos/contracts';
import { estimatedPositionSeconds } from './playback-sync.service';

const snapshot: PlaybackSnapshot = {
  sessionId: '4ea11bcb-89e1-4d37-818c-77a44514de67',
  revision: 1,
  status: 'playing',
  currentQueueItemId: null,
  currentTrackRef: 'source:track',
  positionMs: 12_500,
  positionObservedAt: '2026-09-04T20:00:00.000Z',
  activeDeviceId: '95d2d76e-b1f3-4aad-bb52-d9796f6f20df',
  leaseEpoch: 2,
  leaseExpiresAt: '2026-09-04T20:01:00.000Z',
  queue: [],
};

describe('estimatedPositionSeconds', () => {
  it('advances a remote playing anchor without requiring socket updates', () => {
    expect(estimatedPositionSeconds(snapshot, Date.parse('2026-09-04T20:00:03.250Z')))
      .toBe(15.75);
  });

  it('keeps paused snapshots at their confirmed position', () => {
    expect(estimatedPositionSeconds(
      { ...snapshot, status: 'paused' },
      Date.parse('2026-09-04T20:00:30.000Z'),
    )).toBe(12.5);
  });
});
