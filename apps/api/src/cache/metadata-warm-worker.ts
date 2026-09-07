import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { MetadataWarmRepository, type MetadataWarmJob } from './metadata-warm-repository.js';
import type { MusicSourceService } from '../music-source/music-source-service.js';

const INITIAL_DELAY_MS = 120_000;
const EMPTY_POLL_MS = 15_000;
const NEXT_JOB_MS = 2_000;
const ENQUEUE_INTERVAL_MS = 60 * 60 * 1_000;

export class MetadataWarmWorker {
  private readonly workerId = `metadata-warm-${randomUUID()}`;
  private loopTimer: ReturnType<typeof setTimeout> | null = null;
  private enqueueTimer: ReturnType<typeof setInterval> | null = null;
  private active: Promise<void> | null = null;
  private stopping = false;
  private completedSinceLog = 0;
  private lastEnqueueAt = 0;

  public constructor(
    private readonly repository: MetadataWarmRepository,
    private readonly service: MusicSourceService,
    private readonly logger: Pick<FastifyBaseLogger, 'info' | 'warn'>,
  ) {}

  public start(): void {
    if (this.loopTimer || this.enqueueTimer || this.active) return;
    this.stopping = false;
    this.loopTimer = setTimeout(() => this.scheduleRun(0), INITIAL_DELAY_MS);
    this.loopTimer.unref();
    this.enqueueTimer = setInterval(() => void this.enqueue(), ENQUEUE_INTERVAL_MS);
    this.enqueueTimer.unref();
  }

  public async stop(): Promise<void> {
    this.stopping = true;
    if (this.loopTimer) clearTimeout(this.loopTimer);
    if (this.enqueueTimer) clearInterval(this.enqueueTimer);
    this.loopTimer = null;
    this.enqueueTimer = null;
    await this.active;
  }

  public async enqueueNow(): Promise<void> {
    await this.enqueue();
  }

  private scheduleRun(delay: number): void {
    if (this.stopping) return;
    if (this.loopTimer) clearTimeout(this.loopTimer);
    this.loopTimer = setTimeout(() => {
      this.loopTimer = null;
      this.active = this.run().finally(() => { this.active = null; });
    }, delay);
    this.loopTimer.unref();
  }

  private async run(): Promise<void> {
    if (this.stopping) return;
    try {
      if (this.lastEnqueueAt < Date.now() - ENQUEUE_INTERVAL_MS) await this.enqueue();
      const job = await this.repository.claim(this.workerId);
      if (!job) {
        this.scheduleRun(EMPTY_POLL_MS);
        return;
      }
      await this.process(job);
      this.scheduleRun(NEXT_JOB_MS);
    } catch (error) {
      this.logger.warn({ err: error }, 'Metadata warm worker iteration failed');
      this.scheduleRun(EMPTY_POLL_MS);
    }
  }

  private async enqueue(): Promise<void> {
    this.lastEnqueueAt = Date.now();
    const queued = await this.repository.enqueueStaleArtists();
    if (queued > 0) {
      this.logger.info({ metadataWarm: { outcome: 'enqueued', queued,
        queue: await this.repository.stats() } }, 'Metadata warm queue updated');
    }
  }

  private async process(job: MetadataWarmJob): Promise<void> {
    try {
      await this.service.warmArtistMetadata(job.sourceId, job.remoteArtistId);
      await this.repository.complete(job.id, this.workerId);
      this.completedSinceLog += 1;
      if (this.completedSinceLog >= 20) {
        this.completedSinceLog = 0;
        this.logger.info({ metadataWarm: { outcome: 'progress',
          queue: await this.repository.stats() } }, 'Metadata warm queue progressed');
      }
    } catch (error) {
      const code = error instanceof Error ? error.name.slice(0, 100) : 'UNKNOWN';
      const base = Math.min(24 * 60 * 60 * 1_000,
        60_000 * (2 ** Math.min(10, job.attempts - 1)));
      const retryDelayMs = base + Math.round(base * 0.25 * Math.random());
      await this.repository.fail(job.id, this.workerId, code, retryDelayMs);
      this.logger.warn({ metadataWarm: {
        outcome: 'retry', code, attempts: job.attempts, retryDelayMs,
      } }, 'Metadata warm job deferred');
    }
  }
}
