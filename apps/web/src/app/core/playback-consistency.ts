import type { PlaybackAnchor, PlaybackSnapshot } from '@hirmos/contracts';

export function playbackAnchor(snapshot: PlaybackSnapshot): PlaybackAnchor {
  return { attempt: snapshot.attempt ?? 0, currentQueueItemId: snapshot.currentQueueItemId,
    playbackInstanceId: snapshot.playbackInstanceId, leaseEpoch: snapshot.leaseEpoch };
}

export function samePlaybackAnchor(a: PlaybackAnchor, b: PlaybackAnchor): boolean {
  return (a.attempt ?? 0) === (b.attempt ?? 0) && a.currentQueueItemId === b.currentQueueItemId
    && a.playbackInstanceId === b.playbackInstanceId && a.leaseEpoch === b.leaseEpoch;
}

export function acceptsSnapshot(current: PlaybackSnapshot | null, incoming: PlaybackSnapshot): boolean {
  return !current || (current.sessionId === incoming.sessionId && incoming.revision >= current.revision);
}

/** Deliberate clicks keep their order; failed commands do not poison the tail. */
export class PlaybackCommandSequencer {
  private tail: Promise<unknown> = Promise.resolve();
  public run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task);
    this.tail = result.catch(() => undefined);
    return result;
  }
}
