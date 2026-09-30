import type { PlaybackFailureCode } from '@hirmos/contracts';
import { SourceHttpError } from '../music-source/source-http-error.js';
import { MusicSourceUnavailableError } from '../music-source/music-source-service.js';

/** Ephemeral diagnostics only; durable playback transitions remain in PostgreSQL. */
export class StreamFailureRegistry {
  private readonly entries = new Map<string, { code: PlaybackFailureCode; expires: number; retryAt?: number }>();
  public record(userId: string, requestId: unknown, error: unknown): void {
    if (typeof requestId !== 'string' || !/^[a-f0-9-]{36}$/i.test(requestId)) return;
    let code: PlaybackFailureCode = 'unknown';
    if (error instanceof MusicSourceUnavailableError) code = 'service_unavailable';
    if (error instanceof SourceHttpError) {
      code = error.status === 404 || error.status === 410 ? 'not_found'
        : [401,403,429,503].includes(error.status) ? 'service_unavailable' : 'network';
    }
    const key = `${userId}:${requestId}`;
    this.entries.delete(key);
    this.entries.set(key, { code, expires: Date.now() + 120_000,
      ...(error instanceof SourceHttpError && error.retryAfterMs !== null
        ? { retryAt: Date.now() + error.retryAfterMs } : {}) });
    while (this.entries.size > 1_000) this.entries.delete(this.entries.keys().next().value!);
  }
  public get(userId: string, requestId: string): { code: PlaybackFailureCode; retryAfterMs?: number } | null {
    const key = `${userId}:${requestId}`;
    const result = this.entries.get(key);
    if (!result) return null;
    if (result.expires < Date.now()) { this.entries.delete(key); return null; }
    return { code: result.code, ...(result.retryAt === undefined ? {} : { retryAfterMs: Math.max(0, result.retryAt - Date.now()) }) };
  }
}
