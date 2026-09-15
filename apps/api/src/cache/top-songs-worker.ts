import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type { MusicSourceService } from '../music-source/music-source-service.js';
import { MusicSourceHttpError } from '../music-source/navidrome-adapter.js';
import { TopSongsRepository, type TopSongsJob } from './top-songs-repository.js';

const INITIAL_DELAY_MS = 10_000;
const EMPTY_POLL_MS = 15_000;
const NEXT_JOB_MS = 2_000;
const ENQUEUE_INTERVAL_MS = 60 * 60 * 1_000;
const PERMANENT_RETRY_MS = 30 * 24 * 60 * 60 * 1_000;

export class TopSongsWorker {
  private readonly workerId = `top-songs-${randomUUID()}`;
  private loopTimer: ReturnType<typeof setTimeout> | null = null;
  private enqueueTimer: ReturnType<typeof setInterval> | null = null;
  private active: Promise<void> | null = null;
  private stopping = false;
  private completedSinceLog = 0;
  private lastEnqueueAt = 0;

  public constructor(
    private readonly repository: TopSongsRepository,
    private readonly service: Pick<MusicSourceService, 'refreshArtistTopSongs'>,
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

  public async enqueueNow(): Promise<void> { await this.enqueue(); }

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
      this.logger.warn({ err: error }, 'Top songs worker iteration failed');
      this.scheduleRun(EMPTY_POLL_MS);
    }
  }

  private async enqueue(): Promise<void> {
    this.lastEnqueueAt = Date.now();
    const queued = await this.repository.enqueueDue();
    if (queued > 0) {
      this.logger.info({ topSongs: { outcome: 'enqueued', queued,
        queue: await this.repository.stats() } }, 'Top songs queue updated');
    }
  }

  private async process(job: TopSongsJob): Promise<void> {
    try {
      const outcome = await this.service.refreshArtistTopSongs(job.sourceId, job.remoteArtistId);
      await this.repository.complete(job.id, this.workerId);
      this.completedSinceLog += 1;
      if (outcome !== 'nonempty' || this.completedSinceLog >= 20) {
        this.completedSinceLog = 0;
        this.logger.info({ topSongs: { outcome, queue: await this.repository.stats(job.sourceId) } },
          'Top songs queue progressed');
      }
    } catch (error) {
      await this.repository.recordTemporaryError(job.sourceId, job.remoteArtistId)
        .catch(() => undefined);
      const code = errorCode(error);
      const retryDelayMs = retryDelay(error, job.attempts);
      await this.repository.fail(job.id, this.workerId, code, retryDelayMs);
      this.logger.warn({ topSongs: {
        outcome: 'retry', code, attempts: job.attempts, retryDelayMs,
      } }, 'Top songs job deferred');
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
  const base = Math.min(6 * 60 * 60 * 1_000, 60_000 * (2 ** Math.min(8, attempts - 1)));
  const backoff = base + Math.round(base * 0.25 * Math.random());
  return error instanceof MusicSourceHttpError && error.retryAfterMs
    ? Math.max(backoff, error.retryAfterMs)
    : backoff;
}
