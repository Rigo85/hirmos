import type { FastifyBaseLogger } from 'fastify';
import { LyricsRepository } from '../lyrics/lyrics-repository.js';
import { LyricsObjectCache } from './lyrics-object-cache.js';

export class LyricsCacheBackfillWorker {
  private kickoff: ReturnType<typeof setTimeout> | null = null;
  private active: Promise<void> | null = null;
  private stopping = false;
  private failures = 0;

  public constructor(
    private readonly repository: LyricsRepository,
    private readonly cache: LyricsObjectCache,
    private readonly logger: Pick<FastifyBaseLogger, 'info' | 'warn'>,
  ) {}

  public start(): void {
    if (this.kickoff || this.active) return;
    this.stopping = false;
    this.schedule(30_000);
  }

  private schedule(delay: number): void {
    if (this.stopping) return;
    if (this.kickoff) clearTimeout(this.kickoff);
    this.kickoff = setTimeout(() => { this.kickoff = null; void this.run(); }, delay);
    this.kickoff.unref();
  }

  public async stop(): Promise<void> {
    this.stopping = true;
    if (this.kickoff) clearTimeout(this.kickoff);
    this.kickoff = null;
    await this.active;
  }

  public run(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    return this.active ??= this.performRun().finally(() => { this.active = null; });
  }

  private async performRun(): Promise<void> {
    let migrated = 0;
    try {
      // Bound each pass; continuation retains durable rows, not an in-memory cursor.
      while (!this.stopping && migrated < 1_000) {
        const rows = await this.repository.withoutRawObject(100);
        if (!rows.length) break;
        for (const row of rows) {
          if (this.stopping) break;
          const stored = await this.cache.put({
            sourceId: row.sourceId,
            remoteTrackId: row.remoteTrackId,
            provider: row.provider,
            fingerprint: row.fingerprint,
            normalized: row.document,
          });
          await this.repository.attachRawObject({
            sourceId: row.sourceId,
            remoteTrackId: row.remoteTrackId,
            provider: row.provider,
            fingerprint: row.fingerprint,
            rawObjectKey: stored.key,
            parserVersion: stored.parserVersion,
          });
          migrated += 1;
        }
        if (rows.length < 100) break;
      }
      if (migrated) {
        this.logger.info({ migrated }, 'Existing lyrics cache copied to object storage');
      }
      this.failures = 0;
      if (migrated >= 1_000) this.schedule(30_000);
    } catch (error) {
      this.logger.warn({ err: error, migrated }, 'Existing lyrics cache copy failed');
      this.failures++;
      this.schedule(Math.min(15 * 60_000, 30_000 * 2 ** Math.min(this.failures - 1, 5)) + Math.floor(Math.random() * 5_000));
    }
  }
}
