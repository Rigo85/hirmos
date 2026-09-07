import type { FastifyBaseLogger } from 'fastify';
import { CacheRepository } from './cache-repository.js';
import { ObjectStore } from './object-store.js';

const DAY_MS = 24 * 60 * 60 * 1_000;

export class CacheMaintenanceWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  public constructor(
    private readonly repository: CacheRepository,
    private readonly store: ObjectStore,
    private readonly logger: FastifyBaseLogger,
    private readonly quotaBytes: number,
  ) {}

  public start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.run(), DAY_MS);
    this.timer.unref();
    setTimeout(() => void this.run(), 60_000).unref();
  }

  public stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  public async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      let bytes = await this.repository.physicalByteLength();
      const highWater = this.quotaBytes * 0.9;
      const lowWater = this.quotaBytes * 0.8;
      if (bytes <= highWater) return;
      let removedObjects = 0;
      let removedBytes = 0;
      while (bytes > lowWater) {
        const candidates = await this.repository.evictionCandidates(200);
        if (!candidates.length) break;
        let progress = false;
        for (const candidate of candidates) {
          const unreferenced = await this.repository.removeEntry(candidate.namespace, candidate.key);
          if (!unreferenced) continue;
          await this.store.remove(candidate.relativePath);
          bytes = Math.max(0, bytes - candidate.byteLength);
          removedBytes += candidate.byteLength;
          removedObjects += 1;
          progress = true;
          if (bytes <= lowWater) break;
        }
        if (!progress) break;
      }
      this.logger.info({
        cacheBytes: bytes,
        cacheQuotaBytes: this.quotaBytes,
        removedObjects,
        removedBytes,
      }, 'Hirmos cache maintenance completed');
    } catch (error) {
      this.logger.warn({ err: error }, 'Hirmos cache maintenance failed');
    } finally {
      this.running = false;
    }
  }
}
