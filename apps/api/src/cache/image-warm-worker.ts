import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { ImageCachePendingError } from './image-cache-service.js';
import { ImageWarmRepository, type ImageWarmJob } from './image-warm-repository.js';
import { MusicSourceHttpError } from '../music-source/navidrome-adapter.js';
import type { MusicSourceService } from '../music-source/music-source-service.js';

const INITIAL_DELAY_MS = 20_000;
const EMPTY_POLL_MS = 5_000;
const NEXT_JOB_MS = 250;
const ENQUEUE_INTERVAL_MS = 15 * 60 * 1_000;
const PERMANENT_RETRY_MS = 30 * 24 * 60 * 60 * 1_000;

export class ImageWarmWorker {
  private readonly workerId = `image-warm-${randomUUID()}`;
  private loopTimer: ReturnType<typeof setTimeout> | null = null;
  private enqueueTimer: ReturnType<typeof setInterval> | null = null;
  private active: Promise<void> | null = null;
  private stopping = false;
  private completedSinceLog = 0;
  private lastEnqueueAt = 0;

  public constructor(
    private readonly repository: ImageWarmRepository,
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
      this.logger.warn({ err: error }, 'Image warm worker iteration failed');
      this.scheduleRun(EMPTY_POLL_MS);
    }
  }

  private async enqueue(): Promise<void> {
    this.lastEnqueueAt = Date.now();
    const inserted = await this.repository.enqueueCatalogImages(320);
    if (inserted > 0) {
      const queue = await this.repository.stats();
      this.logger.info({ imageWarm: { outcome: 'enqueued', inserted, queue } },
        'Image warm queue updated');
    }
  }

  private async process(job: ImageWarmJob): Promise<void> {
    try {
      await this.service.warmCover(job.sourceId, job.remoteId, job.size);
      await this.repository.complete(job.id, this.workerId);
      this.completedSinceLog += 1;
      if (this.completedSinceLog >= 50) {
        this.completedSinceLog = 0;
        this.logger.info({ imageWarm: { outcome: 'progress', queue: await this.repository.stats() } },
          'Image warm queue progressed');
      }
    } catch (error) {
      const code = errorCode(error);
      const delay = retryDelay(error, job.attempts);
      await this.repository.fail(job.id, this.workerId, code, delay);
      this.logger.warn({
        imageWarm: { outcome: 'retry', code, attempts: job.attempts, retryDelayMs: delay },
      }, 'Image warm job deferred');
    }
  }
}

function errorCode(error: unknown): string {
  if (error instanceof MusicSourceHttpError) return `HTTP_${error.status}`;
  if (error instanceof Error) return error.name.slice(0, 100);
  return 'UNKNOWN';
}

function retryDelay(error: unknown, attempts: number): number {
  if (error instanceof MusicSourceHttpError && error.status >= 400 && error.status < 500
    && ![408, 425, 429].includes(error.status)) return PERMANENT_RETRY_MS;
  if (error instanceof ImageCachePendingError) return Math.max(error.retryAfterMs, 5_000);
  const base = Math.min(6 * 60 * 60 * 1_000, 30_000 * (2 ** Math.min(10, attempts - 1)));
  return base + Math.round(base * 0.25 * Math.random());
}
