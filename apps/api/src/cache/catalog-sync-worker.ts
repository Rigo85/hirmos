import type { FastifyBaseLogger } from 'fastify';
import type { MusicSourceService } from '../music-source/music-source-service.js';

export class CatalogSyncWorker {
  private interval: NodeJS.Timeout | null = null;
  private kickoff: NodeJS.Timeout | null = null;
  private running = false;

  public constructor(
    private readonly service: MusicSourceService,
    private readonly logger: Pick<FastifyBaseLogger, 'info' | 'warn'>,
    private readonly intervalMs: number,
    private readonly afterSync?: () => Promise<void>,
  ) {}

  public start(): void {
    if (this.interval || this.kickoff) return;
    this.kickoff = setTimeout(() => void this.run(), 10_000);
    this.kickoff.unref();
    this.interval = setInterval(() => void this.run(), this.intervalMs);
    this.interval.unref();
  }

  public stop(): void {
    if (this.kickoff) clearTimeout(this.kickoff);
    if (this.interval) clearInterval(this.interval);
    this.kickoff = null;
    this.interval = null;
  }

  private async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const counts = await this.service.syncCatalog();
      this.logger.info({ catalogSync: { outcome: 'success', ...counts } }, 'Catalog sync completed');
      try {
        await this.afterSync?.();
      } catch (error) {
        this.logger.warn({ err: error }, 'Catalog follow-up scheduling failed');
      }
    } catch (error) {
      this.logger.warn({
        catalogSync: {
          outcome: 'failure',
          reason: error instanceof Error ? error.name : 'unknown',
        },
      }, 'Catalog sync failed');
    } finally {
      this.running = false;
    }
  }
}
