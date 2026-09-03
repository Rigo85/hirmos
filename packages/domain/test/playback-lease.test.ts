import { describe, expect, it } from 'vitest';
import { claimPlaybackLease, ownsPlaybackLease } from '../src/index.js';

describe('playback lease', () => {
  it('increments the epoch and grants ownership to the claimant', () => {
    const lease = claimPlaybackLease(
      { deviceId: null, epoch: 4, expiresAtMs: null },
      'phone',
      1_000,
      15_000,
    );

    expect(lease).toEqual({
      deviceId: 'phone',
      epoch: 5,
      expiresAtMs: 16_000,
    });
    expect(ownsPlaybackLease(lease, 'phone', 5, 2_000)).toBe(true);
    expect(ownsPlaybackLease(lease, 'desktop', 5, 2_000)).toBe(false);
    expect(ownsPlaybackLease(lease, 'phone', 4, 2_000)).toBe(false);
  });

  it('expires deterministically', () => {
    const lease = claimPlaybackLease(
      { deviceId: 'desktop', epoch: 1, expiresAtMs: 10 },
      'phone',
      10,
      50,
    );

    expect(ownsPlaybackLease(lease, 'phone', 2, 59)).toBe(true);
    expect(ownsPlaybackLease(lease, 'phone', 2, 60)).toBe(false);
  });
});
