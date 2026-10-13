import type { FastifyBaseLogger } from 'fastify';
import { CacheRepository } from './cache-repository.js';
import { ObjectStore, type InventoryObject } from './object-store.js';

const DAY_MS = 24 * 60 * 60 * 1_000;
const ORPHAN_GRACE_MS = 7 * DAY_MS;

export class CacheMaintenanceWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private active: Promise<void> | null = null;
  private stopping = false;
  private initialTimer: ReturnType<typeof setTimeout> | null = null;

  public constructor(
    private readonly repository: CacheRepository,
    private readonly store: ObjectStore,
    private readonly logger: FastifyBaseLogger,
    private readonly quotaBytes: number,
  ) {}

  public start(): void {
    if (this.timer || this.active) return;
    this.stopping = false;
    this.timer = setInterval(() => void this.run(), DAY_MS);
    this.timer.unref();
    this.initialTimer = setTimeout(() => void this.run(), 60_000);
    this.initialTimer.unref();
  }

  public async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    if (this.initialTimer) clearTimeout(this.initialTimer);
    this.initialTimer = null;
    this.timer = null;
    await this.active;
  }

  public run(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    return this.active ??= this.performRun().finally(() => { this.active = null; });
  }

  private async performRun(): Promise<void> {
    try {
      const references = await this.repository.referencedHashes();
      const orphans: InventoryObject[] = [];
      let bytes = 0;
      let untrackedBytes = 0;
      // Finish inventory before deletion: permissions/symlinks abort safely.
      for await (const object of this.store.inventory()) {
        if (this.stopping) return;
        bytes += object.byteLength;
        if (!object.hash) untrackedBytes += object.byteLength;
        else if (!references.has(object.hash)) orphans.push(object);
      }
      let removedObjects = 0;
      let removedBytes = 0;
      let mutationAttempts = 0;
      const deadline = Date.now() + 120_000;
      const hasBudget = () => !this.stopping && mutationAttempts < 2_000 && Date.now() < deadline;
      for (const object of orphans) {
        if (!hasBudget()) break;
        mutationAttempts += 1;
        const removed = await this.repository.withMaintenance(async (repository) => {
          if (!await repository.orphanEligible(object.hash!, ORPHAN_GRACE_MS)) return false;
          await this.store.remove(object.relativePath);
          await repository.forgetOrphan(object.hash!);
          return true;
        });
        if (removed) {
          bytes = Math.max(0, bytes - object.byteLength);
          removedBytes += object.byteLength;
          removedObjects += 1;
        }
      }
      const highWater = this.quotaBytes * 0.9;
      const lowWater = this.quotaBytes * 0.8;
      let evicting = bytes > highWater;
      while (evicting && bytes > lowWater && hasBudget()) {
        const candidates = await this.repository.evictionCandidates(200);
        if (!candidates.length) break;
        let progress = false;
        for (const candidate of candidates) {
          if (!hasBudget()) break;
          mutationAttempts += 1;
          const unreferenced = await this.repository.withMaintenance(async (repository) => {
            const lastReference = await repository.removeEntry(candidate.namespace, candidate.key, candidate.contentHash);
            if (!lastReference) return false;
            await this.store.remove(candidate.relativePath);
            await repository.forgetOrphan(candidate.contentHash);
            return true;
          });
          if (!unreferenced) continue;
          bytes = Math.max(0, bytes - candidate.byteLength);
          removedBytes += candidate.byteLength;
          removedObjects += 1;
          progress = true;
          if (bytes <= lowWater) break;
        }
        // Shared objects can lose references without freeing bytes; continue if
        // the next batch differs, otherwise avoid spinning on a stale candidate.
        if (!progress) {
          const next = await this.repository.evictionCandidates(200);
          evicting = next.length > 0 && next.some(item =>
            !candidates.some(previous => previous.namespace === item.namespace && previous.key === item.key
              && previous.contentHash === item.contentHash));
        }
      }
      this.logger.info({
        cacheBytes: bytes,
        cacheQuotaBytes: this.quotaBytes,
        removedObjects,
        removedBytes,
        orphanCandidates: orphans.length,
        untrackedBytes,
        aboveQuota: bytes > highWater,
        mutationBudgetExhausted: !hasBudget(),
      }, 'Hirmos cache maintenance completed');
    } catch (error) {
      this.logger.warn({ err: error }, 'Hirmos cache maintenance failed');
    }
  }
}
