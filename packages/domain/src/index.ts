export interface PlaybackLease {
  deviceId: string | null;
  epoch: number;
  expiresAtMs: number | null;
}

/** Queue order is authoritative, including an already-shuffled context. */
export function nextQueueItem<T extends { id: string; trackRef: string }>(
  queue: readonly T[], currentId: string | null,
  options: { omitted?: readonly string[]; repeat?: 'off' | 'one' | 'all'; failed?: boolean } = {},
): T | null {
  const index = queue.findIndex(item => item.id === currentId);
  if (index < 0) return null;
  const omitted = new Set(options.omitted ?? []);
  if (options.repeat === 'one' && !options.failed && !omitted.has(queue[index]!.trackRef)) return queue[index]!;
  const candidates = queue.slice(index + 1);
  if (options.repeat === 'all') candidates.push(...queue.slice(0, index + 1));
  return candidates.find(item => !omitted.has(item.trackRef)) ?? null;
}

/** Previous restarts after three seconds; before that it follows visible order. */
export function previousQueueItem<T extends { id: string; trackRef: string }>(
  queue: readonly T[], currentId: string | null,
  options: { positionMs: number; omitted?: readonly string[]; repeat?: 'off' | 'one' | 'all' },
): T | null {
  const index = queue.findIndex(item => item.id === currentId);
  if (index < 0) return null;
  const omitted = new Set(options.omitted ?? []);
  const current = queue[index]!;
  if (options.positionMs >= 3_000 && !omitted.has(current.trackRef)) return current;
  const candidates = queue.slice(0, index).reverse();
  if (options.repeat === 'all') candidates.push(...queue.slice(index).reverse());
  return candidates.find(item => !omitted.has(item.trackRef))
    ?? (!omitted.has(current.trackRef) ? current : null);
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
