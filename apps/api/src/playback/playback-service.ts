import type { PlaybackCommandResult, PlaybackSnapshot } from '@hirmos/contracts';
import { decodeTrackReference } from '../music-source/track-reference.js';
import { PlaybackRepository } from './playback-repository.js';

export class PlaybackService {
  public constructor(
    private readonly repository: PlaybackRepository,
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
    return this.repository.select({
      ...input,
      sourceId: reference.sourceId,
      remoteTrackId: reference.remoteId,
    });
  }

  public async update(input: Parameters<PlaybackRepository['update']>[0]): Promise<PlaybackCommandResult> {
    return this.repository.update(input);
  }

  public failure(input: Parameters<PlaybackRepository['failure']>[0]): Promise<PlaybackCommandResult> {
    return this.repository.failure(input);
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
    replaceQueueRevision?:number;
  }): Promise<PlaybackCommandResult> {
    const references = input.trackRefs.map(decodeTrackReference);
    const sourceId = references[0]?.sourceId;
    if (!sourceId || references.some((reference) => !reference || reference.sourceId !== sourceId)) {
      return { status: 'conflict', snapshot: await this.repository.snapshot(input.userId) };
    }
    return this.repository.selectContext({
      userId: input.userId,
      deviceId: input.deviceId,
      commandId: input.commandId,
      expectedRevision: input.expectedRevision,
      sourceId,
      remoteTrackIds: references.map((reference) => reference!.remoteId),
      selectedIndex: input.selectedIndex,
      contextType: input.contextType,
      contextRef: input.contextRef,
      replaceQueueRevision:input.replaceQueueRevision,
    });
  }

  public async control(input: Parameters<PlaybackRepository['control']>[0] & {
    reason?: 'user' | 'ended';
  }): Promise<PlaybackCommandResult> {
    return this.repository.control(input);
  }

  public selectPlaylist(input:Parameters<PlaybackRepository['selectPlaylist']>[0]):Promise<PlaybackCommandResult> {
    return this.repository.selectPlaylist(input);
  }
  public setRepeat(input:Parameters<PlaybackRepository['setRepeat']>[0]):Promise<PlaybackCommandResult> {
    return this.repository.setRepeat(input);
  }
  public selectFavorites(input:Parameters<PlaybackRepository['selectFavorites']>[0]):Promise<PlaybackCommandResult> {
    return this.repository.selectFavorites(input);
  }
  public editQueue(input:Parameters<PlaybackRepository['editQueue']>[0]):Promise<PlaybackCommandResult> {
    return this.repository.editQueue(input);
  }

  public removeQueueItem(
    input: Parameters<PlaybackRepository['removeQueueItem']>[0],
  ): Promise<PlaybackCommandResult> {
    return this.repository.removeQueueItem(input);
  }

}
