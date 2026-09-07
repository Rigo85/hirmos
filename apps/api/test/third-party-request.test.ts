import { describe, expect, it, vi } from 'vitest';
import {
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
