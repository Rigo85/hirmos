import { describe, expect, it, vi } from 'vitest';
import {
  fetchStreamingResponseWithRetry,
  fetchWithRetry,
  isRetryableStatus,
  parseRetryAfter,
  ThirdPartyTelemetry,
} from '../src/integrations/third-party-request.js';

describe('fetchWithRetry', () => {
  it('retries a transient response and reports a successful recovery', async () => {
    const fetchImplementation = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ ok: true }));
    const telemetry = new ThirdPartyTelemetry();
    const debug = vi.fn();
    const warn = vi.fn();
    telemetry.attachLogger({ debug, warn });

    const response = await fetchWithRetry(fetchImplementation, new URL('https://example.test'), {}, {
      provider: 'example', operation: 'read', attemptTimeoutMs: 100,
      totalTimeoutMs: 500, maxAttempts: 2, baseDelayMs: 0, telemetry,
    });

    expect(response.status).toBe(200);
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({
      thirdParty: expect.objectContaining({ outcome: 'retry', status: 503, attempt: 1 }),
    }), expect.any(String));
    expect(debug).toHaveBeenCalledWith(expect.objectContaining({
      thirdParty: expect.objectContaining({ outcome: 'success', attempt: 2 }),
    }), expect.any(String));
  });

  it('does not retry a normal miss or a permanent client error', async () => {
    for (const status of [404, 401]) {
      const fetchImplementation = vi.fn(async () => new Response(null, { status }));
      const response = await fetchWithRetry(fetchImplementation, new URL('https://example.test'), {}, {
        provider: 'example', operation: 'read', attemptTimeoutMs: 100,
        totalTimeoutMs: 500, maxAttempts: 2, baseDelayMs: 0,
      });
      expect(response.status).toBe(status);
      expect(fetchImplementation).toHaveBeenCalledTimes(1);
    }
  });

  it('does not replay a non-idempotent request without an explicit delivery mechanism', async () => {
    const fetchImplementation = vi.fn(async () => new Response(null, { status: 503 }));

    const response = await fetchWithRetry(fetchImplementation, new URL('https://example.test'), {
      method: 'POST', body: 'payload',
    }, {
      provider: 'example', operation: 'write', attemptTimeoutMs: 100,
      totalTimeoutMs: 500, maxAttempts: 2, baseDelayMs: 0,
    });

    expect(response.status).toBe(503);
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });

  it('honors Retry-After and the transient status allowlist', () => {
    expect(parseRetryAfter('1.5')).toBe(1_500);
    expect(parseRetryAfter('invalid')).toBeNull();
    expect(isRetryableStatus(408)).toBe(true);
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(409)).toBe(false);
  });
});

describe('fetchStreamingResponseWithRetry', () => {
  it('stops the short timeout at headers and keeps a slow body readable', async () => {
    const fetchImplementation = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      const signal = init?.signal;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const timeout = setTimeout(() => {
            controller.enqueue(new Uint8Array([1, 2, 3]));
            controller.close();
          }, 60);
          signal?.addEventListener('abort', () => {
            clearTimeout(timeout);
            controller.error(signal.reason);
          }, { once: true });
        },
      });
      return new Response(body);
    });

    const response = await fetchStreamingResponseWithRetry(
      fetchImplementation as typeof fetch,
      new URL('https://example.test/audio'),
      {},
      {
        provider: 'example', operation: 'stream', attemptTimeoutMs: 20,
        totalTimeoutMs: 40, maxAttempts: 1,
      },
    );

    await expect(response.arrayBuffer()).resolves.toEqual(new Uint8Array([1, 2, 3]).buffer);
  });

  it('still cancels the body when the real caller disconnects', async () => {
    const caller = new AbortController();
    const fetchImplementation = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      const signal = init?.signal;
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          signal?.addEventListener('abort', () => controller.error(signal.reason), { once: true });
        },
      }));
    });
    const response = await fetchStreamingResponseWithRetry(
      fetchImplementation as typeof fetch,
      new URL('https://example.test/audio'),
      {},
      {
        provider: 'example', operation: 'stream', signal: caller.signal,
        attemptTimeoutMs: 100, totalTimeoutMs: 200, maxAttempts: 1,
      },
    );

    caller.abort(new DOMException('Listener disconnected', 'AbortError'));
    await expect(response.arrayBuffer()).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('retains the bounded timeout while waiting for headers', async () => {
    const fetchImplementation = vi.fn((_input: URL | RequestInfo, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      }));

    await expect(fetchStreamingResponseWithRetry(
      fetchImplementation as typeof fetch,
      new URL('https://example.test/audio'),
      {},
      {
        provider: 'example', operation: 'stream', attemptTimeoutMs: 15,
        totalTimeoutMs: 30, maxAttempts: 1,
      },
    )).rejects.toMatchObject({ name: 'TimeoutError' });
  });
});
