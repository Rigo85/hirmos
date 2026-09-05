import type { PlaybackCommandResult, PlaybackSnapshot } from '@hirmos/contracts';
import { decodeTrackReference } from '../music-source/track-reference.js';
import { PlaybackRepository } from './playback-repository.js';
import type { ActivityRepository } from '../activity/activity-repository.js';

export class PlaybackService {
  public constructor(
    private readonly repository: PlaybackRepository,
    private readonly activity?: ActivityRepository,
  ) {}

  public registerDevice(input: {
    userId: string;
    deviceId: string;
    name: string;
    type: string;
  }): Promise<boolean> {
    return this.repository.registerDevice(input);
  }

  public snapshot(userId: string): Promise<PlaybackSnapshot> {
    return this.repository.snapshot(userId);
  }

  public claim(input: Parameters<PlaybackRepository['claim']>[0]): Promise<PlaybackCommandResult> {
    return this.repository.claim(input);
  }

  public async select(input: {
    userId: string;
    deviceId: string;
    commandId: string;
    expectedRevision: number;
    trackRef: string;
  }): Promise<PlaybackCommandResult> {
    const reference = decodeTrackReference(input.trackRef);
    if (!reference) {
      return this.repository.snapshot(input.userId).then((snapshot) => ({
        status: 'conflict' as const,
        snapshot,
      }));
    }
    const result = await this.repository.select({
      ...input,
      sourceId: reference.sourceId,
      remoteTrackId: reference.remoteId,
    });
    if (result.status === 'accepted') {
      await this.capture(() => this.activity?.recordEvent({
        userId: input.userId, deviceId: input.deviceId, snapshot: result.snapshot, type: 'started',
      }));
    }
    return result;
  }

  public async update(input: Parameters<PlaybackRepository['update']>[0]): Promise<PlaybackCommandResult> {
    const before = this.activity ? await this.repository.snapshot(input.userId) : null;
    const result = await this.repository.update(input);
    if (before && result.status === 'accepted') {
      await this.capture(() => this.activity?.recordProgress({
        userId: input.userId, before, after: result.snapshot,
      }));
    }
    return result;
  }

  public async selectContext(input: {
    userId: string;
    deviceId: string;
    commandId: string;
    expectedRevision: number;
    trackRefs: string[];
    selectedIndex: number;
    contextType: 'album' | 'artist' | 'search' | 'home' | 'genre' | 'favorites';
    contextRef: string | null;
  }): Promise<PlaybackCommandResult> {
    const references = input.trackRefs.map(decodeTrackReference);
    const sourceId = references[0]?.sourceId;
    if (!sourceId || references.some((reference) => !reference || reference.sourceId !== sourceId)) {
      return { status: 'conflict', snapshot: await this.repository.snapshot(input.userId) };
    }
    const result = await this.repository.selectContext({
      userId: input.userId,
      deviceId: input.deviceId,
      commandId: input.commandId,
      expectedRevision: input.expectedRevision,
      sourceId,
      remoteTrackIds: references.map((reference) => reference!.remoteId),
      selectedIndex: input.selectedIndex,
      contextType: input.contextType,
      contextRef: input.contextRef,
    });
    if (result.status === 'accepted') {
      await this.capture(() => this.activity?.recordEvent({
        userId: input.userId, deviceId: input.deviceId, snapshot: result.snapshot, type: 'started',
      }));
    }
    return result;
  }

  public async control(input: Parameters<PlaybackRepository['control']>[0] & {
    reason?: 'user' | 'ended';
  }): Promise<PlaybackCommandResult> {
    const before = this.activity ? await this.repository.snapshot(input.userId) : null;
    const result = await this.repository.control(input);
    if (before && result.status === 'accepted') {
      if (input.action === 'next') {
        await this.capture(() => this.activity?.recordEvent({
          userId: input.userId, deviceId: input.deviceId, snapshot: before,
          type: input.reason === 'ended' ? 'completed' : 'skipped',
        }));
        if (result.snapshot.currentTrackRef !== before.currentTrackRef) {
          await this.capture(() => this.activity?.recordEvent({
            userId: input.userId, deviceId: input.deviceId, snapshot: result.snapshot, type: 'started',
          }));
        }
      } else if (input.action === 'previous') {
        if (result.snapshot.currentTrackRef !== before.currentTrackRef) {
          await this.capture(() => this.activity?.recordEvent({
            userId: input.userId, deviceId: input.deviceId, snapshot: result.snapshot, type: 'started',
          }));
        }
      } else {
        const type = input.action === 'play' ? 'resumed'
          : input.action === 'pause' ? 'paused' : 'seeked';
        await this.capture(() => this.activity?.recordEvent({
          userId: input.userId, deviceId: input.deviceId, snapshot: result.snapshot, type,
        }));
      }
    }
    return result;
  }

  public removeQueueItem(
    input: Parameters<PlaybackRepository['removeQueueItem']>[0],
  ): Promise<PlaybackCommandResult> {
    return this.repository.removeQueueItem(input);
  }

  private async capture(operation: () => Promise<void> | undefined): Promise<void> {
    try { await operation(); } catch { /* Telemetry must never break playback. */ }
  }
}
