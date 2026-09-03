export interface PlaybackLease {
  deviceId: string | null;
  epoch: number;
  expiresAtMs: number | null;
}

export function claimPlaybackLease(
  current: PlaybackLease,
  deviceId: string,
  nowMs: number,
  ttlMs: number,
): PlaybackLease {
  if (ttlMs <= 0) {
    throw new RangeError('ttlMs must be greater than zero');
  }

  return {
    deviceId,
    epoch: current.epoch + 1,
    expiresAtMs: nowMs + ttlMs,
  };
}

export function ownsPlaybackLease(
  lease: PlaybackLease,
  deviceId: string,
  epoch: number,
  nowMs: number,
): boolean {
  return (
    lease.deviceId === deviceId &&
    lease.epoch === epoch &&
    lease.expiresAtMs !== null &&
    lease.expiresAtMs > nowMs
  );
}
