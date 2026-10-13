import type { FastifyBaseLogger } from 'fastify';
import type { CatalogSyncControl } from './catalog-sync-coordinator.js';

export class CatalogSyncWorker {
  private interval: NodeJS.Timeout | null = null;
  private kickoff: NodeJS.Timeout | null = null;
  private active: Promise<void> | null = null;
  private stopping = false;

  public constructor(
    private readonly coordinator: CatalogSyncControl,
    private readonly logger: Pick<FastifyBaseLogger, 'info' | 'warn'>,
    private readonly intervalMs: number,
  ) {}

  public start(): void {
    if (this.interval || this.kickoff || this.active) return;
    this.stopping = false;
    this.kickoff = setTimeout(() => void this.run(), 10_000);
    this.kickoff.unref();
    this.interval = setInterval(() => void this.run(), this.intervalMs);
    this.interval.unref();
  }

  public async stop(): Promise<void> {
    this.stopping = true;
    if (this.kickoff) clearTimeout(this.kickoff);
    if (this.interval) clearInterval(this.interval);
    this.kickoff = null;
    this.interval = null;
    await this.active;
  }

  private run(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    return this.active ??= this.performRun().finally(() => { this.active = null; });
  }

  private async performRun(): Promise<void> {
    try {
      const trigger = this.coordinator.trigger();
      const { counts, followUpError } = await trigger.completion;
      this.logger.info({ catalogSync: { outcome: 'success', ...counts } }, 'Catalog sync completed');
      if (followUpError) {
        this.logger.warn({ err: followUpError }, 'Catalog follow-up scheduling failed');
      }
    } catch (error) {
      this.logger.warn({
        catalogSync: {
          outcome: 'failure',
          reason: error instanceof Error ? error.name : 'unknown',
        },
      }, 'Catalog sync failed');
    }
  }
}
