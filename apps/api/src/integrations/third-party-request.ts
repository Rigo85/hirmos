import type { FastifyBaseLogger } from 'fastify';

export type ThirdPartyRequestOutcome = 'success' | 'not_found' | 'retry' | 'failure';

export interface ThirdPartyRequestEvent {
  provider: string;
  operation: string;
  attempt: number;
  maxAttempts: number;
  elapsedMs: number;
  outcome: ThirdPartyRequestOutcome;
  status?: number;
  reason?: 'http' | 'network' | 'timeout' | 'unknown';
  retryDelayMs?: number;
}

export class ThirdPartyTelemetry {
  private logger: Pick<FastifyBaseLogger, 'debug' | 'warn'> | null = null;

  public attachLogger(logger: Pick<FastifyBaseLogger, 'debug' | 'warn'>): void {
    this.logger = logger;
  }

  public record(event: ThirdPartyRequestEvent): void {
    if (!this.logger) return;
    const fields = { thirdParty: event };
    if (event.outcome === 'retry' || event.outcome === 'failure') {
      this.logger.warn(fields, 'Third-party request did not complete normally');
      return;
    }
    this.logger.debug(fields, 'Third-party request completed');
  }
}

export interface ThirdPartyFetchOptions {
  provider: string;
  operation: string;
  signal?: AbortSignal;
  attemptTimeoutMs: number;
  totalTimeoutMs: number;
  maxAttempts?: number;
  baseDelayMs?: number;
  telemetry?: ThirdPartyTelemetry;
  random?: () => number;
}

export async function fetchWithRetry(
  fetchImplementation: typeof fetch,
  input: URL | RequestInfo,
  init: Omit<RequestInit, 'signal'>,
  options: ThirdPartyFetchOptions,
): Promise<Response> {
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 2));
  const attemptTimeoutMs = positiveMilliseconds(options.attemptTimeoutMs, 'attemptTimeoutMs');
  const totalTimeoutMs = positiveMilliseconds(options.totalTimeoutMs, 'totalTimeoutMs');
  const baseDelayMs = Math.max(0, Math.floor(options.baseDelayMs ?? 200));
  const random = options.random ?? Math.random;
  const retryAllowed = isReplaySafeRequest(input, init);
  const startedAt = Date.now();
  const deadline = startedAt + totalTimeoutMs;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    throwIfCallerAborted(options.signal);
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new DOMException('Third-party request budget expired', 'TimeoutError');
    const attemptStartedAt = Date.now();
    const timeoutSignal = AbortSignal.timeout(Math.min(attemptTimeoutMs, remainingMs));
    const attemptSignal = options.signal
      ? AbortSignal.any([options.signal, timeoutSignal])
      : timeoutSignal;

    try {
      const response = await fetchImplementation(input, { ...init, signal: attemptSignal });
      const elapsedMs = Date.now() - attemptStartedAt;
      if (!isRetryableStatus(response.status) || !retryAllowed) {
        options.telemetry?.record({
          provider: options.provider,
          operation: options.operation,
          attempt,
          maxAttempts,
          elapsedMs,
          outcome: response.status === 404 ? 'not_found' : response.ok ? 'success' : 'failure',
          status: response.status,
          reason: response.ok || response.status === 404 ? undefined : 'http',
        });
        return response;
      }

      const retryDelayMs = retryDelay(response, attempt, baseDelayMs, random);
      if (!canRetry(attempt, maxAttempts, deadline, retryDelayMs)) {
        options.telemetry?.record({
          provider: options.provider,
          operation: options.operation,
          attempt,
          maxAttempts,
          elapsedMs,
          outcome: 'failure',
          status: response.status,
          reason: 'http',
        });
        return response;
      }
      options.telemetry?.record({
        provider: options.provider,
        operation: options.operation,
        attempt,
        maxAttempts,
        elapsedMs,
        outcome: 'retry',
        status: response.status,
        reason: 'http',
        retryDelayMs,
      });
      await response.body?.cancel().catch(() => undefined);
      await abortableDelay(retryDelayMs, options.signal);
    } catch (error) {
      throwIfCallerAborted(options.signal);
      const elapsedMs = Date.now() - attemptStartedAt;
      const reason = errorReason(error);
      const retryDelayMs = backoffDelay(attempt, baseDelayMs, random);
      if (!retryAllowed || !isRetryableError(error)
        || !canRetry(attempt, maxAttempts, deadline, retryDelayMs)) {
        options.telemetry?.record({
          provider: options.provider,
          operation: options.operation,
          attempt,
          maxAttempts,
          elapsedMs,
          outcome: 'failure',
          reason,
        });
        throw error;
      }
      options.telemetry?.record({
        provider: options.provider,
        operation: options.operation,
        attempt,
        maxAttempts,
        elapsedMs,
        outcome: 'retry',
        reason,
        retryDelayMs,
      });
      await abortableDelay(retryDelayMs, options.signal);
    }
  }

  throw new Error('Third-party retry loop ended unexpectedly');
}

function isReplaySafeRequest(input: URL | RequestInfo, init: Omit<RequestInit, 'signal'>): boolean {
  const method = (init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  return method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
}

export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export function parseRetryAfter(value: string | null, now = Date.now()): number | null {
  if (!value) return null;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

function retryDelay(
  response: Response,
  attempt: number,
  baseDelayMs: number,
  random: () => number,
): number {
  return parseRetryAfter(response.headers.get('retry-after'))
    ?? backoffDelay(attempt, baseDelayMs, random);
}

function backoffDelay(attempt: number, baseDelayMs: number, random: () => number): number {
  const base = baseDelayMs * (2 ** Math.max(0, attempt - 1));
  return Math.round(base + base * 0.25 * Math.max(0, Math.min(1, random())));
}

function canRetry(attempt: number, maxAttempts: number, deadline: number, delayMs: number): boolean {
  return attempt < maxAttempts && Date.now() + delayMs < deadline;
}

function isRetryableError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as { name?: unknown; code?: unknown };
  if (value.name === 'TimeoutError' || value.name === 'AbortError' || value.name === 'TypeError') {
    return true;
  }
  return typeof value.code === 'string' && [
    'ECONNRESET', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND',
    'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_SOCKET',
  ].includes(value.code);
}

function errorReason(error: unknown): 'network' | 'timeout' | 'unknown' {
  if (error && typeof error === 'object') {
    const value = error as { name?: unknown; code?: unknown };
    if (value.name === 'TimeoutError' || value.code === 'ETIMEDOUT'
      || value.code === 'UND_ERR_CONNECT_TIMEOUT' || value.code === 'UND_ERR_HEADERS_TIMEOUT') {
      return 'timeout';
    }
    if (value.name === 'TypeError' || value.name === 'AbortError' || typeof value.code === 'string') {
      return 'network';
    }
  }
  return 'unknown';
}

function throwIfCallerAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason;
}

function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timeout = setTimeout(resolve, milliseconds);
    signal?.addEventListener('abort', () => {
      clearTimeout(timeout);
      reject(signal.reason);
    }, { once: true });
  });
}

function positiveMilliseconds(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`);
  return Math.floor(value);
}
