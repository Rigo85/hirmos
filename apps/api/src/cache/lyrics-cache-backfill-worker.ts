import type { FastifyBaseLogger } from 'fastify';
import { LyricsRepository } from '../lyrics/lyrics-repository.js';
import { LyricsObjectCache } from './lyrics-object-cache.js';

export class LyricsCacheBackfillWorker {
  private kickoff: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  public constructor(
    private readonly repository: LyricsRepository,
    private readonly cache: LyricsObjectCache,
    private readonly logger: Pick<FastifyBaseLogger, 'info' | 'warn'>,
  ) {}

  public start(): void {
    if (this.kickoff) return;
    this.kickoff = setTimeout(() => void this.run(), 30_000);
    this.kickoff.unref();
  }

  public stop(): void {
    if (this.kickoff) clearTimeout(this.kickoff);
    this.kickoff = null;
  }

  public async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    let migrated = 0;
    try {
      while (true) {
        const rows = await this.repository.withoutRawObject(100);
        if (!rows.length) break;
        for (const row of rows) {
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
    } catch (error) {
      this.logger.warn({ err: error, migrated }, 'Existing lyrics cache copy failed');
    } finally {
      this.running = false;
      this.kickoff = null;
    }
  }
}
