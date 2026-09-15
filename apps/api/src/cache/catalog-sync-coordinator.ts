import type { CatalogSyncStatus } from '@hirmos/contracts';
import type { CatalogSyncResult, MusicSourceService } from '../music-source/music-source-service.js';

export interface CatalogSyncCompletion {
  counts: { artists: number; albums: number; tracks: number };
  followUpError: unknown | null;
}

export interface CatalogSyncTrigger {
  started: boolean;
  completion: Promise<CatalogSyncCompletion>;
}

export interface CatalogSyncControl {
  status(): CatalogSyncStatus;
  trigger(): CatalogSyncTrigger;
}

export class CatalogSyncCoordinator implements CatalogSyncControl {
  private current: Promise<CatalogSyncCompletion> | null = null;
  private afterSync: ((result: CatalogSyncResult) => Promise<void>) | undefined;
  private currentStatus: CatalogSyncStatus = {
    status: 'idle',
    startedAt: null,
    completedAt: null,
    counts: null,
  };

  public constructor(
    private readonly service: Pick<MusicSourceService, 'syncCatalog'>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public setAfterSync(callback: (result: CatalogSyncResult) => Promise<void>): void {
    this.afterSync = callback;
  }

  public status(): CatalogSyncStatus {
    return {
      ...this.currentStatus,
      counts: this.currentStatus.counts ? { ...this.currentStatus.counts } : null,
    };
  }

  public trigger(): CatalogSyncTrigger {
    if (this.current) {
      return { started: false, completion: this.current };
    }

    const startedAt = this.now().toISOString();
    this.currentStatus = {
      status: 'running',
      startedAt,
      completedAt: null,
      counts: null,
    };
    const completion = this.run(startedAt);
    this.current = completion;
    // Every caller may choose to observe completion, but a background trigger
    // must never create an unhandled rejection if the request has already ended.
    void completion.catch(() => undefined);
    return { started: true, completion };
  }

  private async run(startedAt: string): Promise<CatalogSyncCompletion> {
    try {
      const result = await this.service.syncCatalog();
      const counts = { artists: result.artists, albums: result.albums, tracks: result.tracks };
      let followUpError: unknown | null = null;
      try {
        await this.afterSync?.(result);
      } catch (error) {
        followUpError = error;
      }
      this.currentStatus = {
        status: 'succeeded',
        startedAt,
        completedAt: this.now().toISOString(),
        counts,
      };
      return { counts, followUpError };
    } catch (error) {
      this.currentStatus = {
        status: 'failed',
        startedAt,
        completedAt: this.now().toISOString(),
        counts: null,
      };
      throw error;
    } finally {
      this.current = null;
    }
  }
}
